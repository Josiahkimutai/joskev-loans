const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ===================================================
   ENV VARIABLES
=================================================== */
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  SUPABASE_URL,
  SUPABASE_KEY
} = process.env;

/* ===================================================
   SUPABASE
=================================================== */
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

/* ===================================================
   HOME ROUTE
=================================================== */
app.get("/", (req, res) => {
  res.send("M-Pesa + Supabase Server Running 🚀");
});

/* ===================================================
   GET ACCESS TOKEN
=================================================== */
async function getAccessToken() {
  try {
    const auth = Buffer.from(
      `${CONSUMER_KEY}:${CONSUMER_SECRET}`
    ).toString("base64");

    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`
        }
      }
    );

    return response.data.access_token;
  } catch (err) {
    console.log(
      "TOKEN ERROR:",
      err.response?.data || err.message
    );
    throw err;
  }
}

/* ===================================================
   STK PUSH
=================================================== */
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        error: "Phone and amount required"
      });
    }

    const token = await getAccessToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      `${SHORTCODE}${PASSKEY}${timestamp}`
    ).toString("base64");

    const stkBody = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Number(amount),
      PartyA: phone,
      PartyB: SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: "FACEBOOK_APP",
      TransactionDesc: "Payment"
    };

    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      stkBody,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log("STK RESPONSE:");
    console.log(response.data);

    const stkData = response.data;

    /* SAVE PENDING PAYMENT IMMEDIATELY */
    if (stkData.CheckoutRequestID) {
      const { error: insertError } = await supabase
        .from("payments")
        .insert([
          {
            phone,
            amount: Number(amount),
            checkout_request_id: stkData.CheckoutRequestID,
            merchant_request_id: stkData.MerchantRequestID || null,
            status: "PENDING",
            result_desc: "Waiting for M-Pesa callback"
          }
        ]);

      if (insertError) {
        console.log("PENDING PAYMENT SAVE ERROR:", insertError.message);
      } else {
        console.log("PENDING PAYMENT SAVED ✅");
      }
    }

    res.json(stkData);
  } catch (err) {
    console.log(
      "STK ERROR:",
      err.response?.data || err.message
    );

    res.status(500).json(
      err.response?.data || {
        error: err.message
      }
    );
  }
});

/* ===================================================
   CALLBACK
=================================================== */
app.post("/callback", async (req, res) => {
  try {
    console.log("CALLBACK RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    const stk = req.body?.Body?.stkCallback;

    if (!stk) {
      console.log("No stkCallback found in callback body");
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutRequestID = stk.CheckoutRequestID || null;
    const merchantRequestID = stk.MerchantRequestID || null;
    const resultCode = stk.ResultCode;
    const resultDesc = stk.ResultDesc || "";

    /* PAYMENT SUCCESS */
    if (resultCode === 0) {
      const items = stk.CallbackMetadata?.Item || [];

      const phone =
        items.find(i => i.Name === "PhoneNumber")?.Value || null;

      const amount =
        items.find(i => i.Name === "Amount")?.Value || null;

      const receipt =
        items.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;

      const transactionDate =
        items.find(i => i.Name === "TransactionDate")?.Value || null;

      /* UPDATE PAYMENT TO SUCCESS */
      const { error: updatePaymentError } = await supabase
        .from("payments")
        .update({
          phone,
          amount,
          mpesa_receipt: receipt,
          transaction_date: transactionDate ? String(transactionDate) : null,
          merchant_request_id: merchantRequestID,
          status: "SUCCESS",
          result_code: resultCode,
          result_desc: resultDesc
        })
        .eq("checkout_request_id", checkoutRequestID);

      if (updatePaymentError) {
        console.log("PAYMENT UPDATE ERROR:", updatePaymentError.message);
      } else {
        console.log("PAYMENT UPDATED TO SUCCESS ✅");
      }

      /* UPDATE USER */
      const { error: userError } = await supabase
        .from("users")
        .upsert(
          {
            phone,
            is_paid: true
          },
          {
            onConflict: "phone"
          }
        );

      if (userError) {
        console.log("USER UPDATE ERROR:", userError.message);
      } else {
        console.log("USER UPDATED ✅");
      }
    } else {
      /* PAYMENT FAILED / CANCELLED / TIMED OUT */
      const { error: failUpdateError } = await supabase
        .from("payments")
        .update({
          merchant_request_id: merchantRequestID,
          status: "FAILED",
          result_code: resultCode,
          result_desc: resultDesc
        })
        .eq("checkout_request_id", checkoutRequestID);

      if (failUpdateError) {
        console.log("FAILED PAYMENT UPDATE ERROR:", failUpdateError.message);
      } else {
        console.log("PAYMENT MARKED FAILED ✅");
      }

      console.log("PAYMENT FAILED:", resultDesc);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

/* ===================================================
   PAYMENT STATUS CHECK
   FRONTEND CALLS:
   /payment-status/:checkoutRequestID
=================================================== */
app.get("/payment-status/:checkoutRequestID", async (req, res) => {
  try {
    const { checkoutRequestID } = req.params;

    if (!checkoutRequestID) {
      return res.status(400).json({
        success: false,
        error: "checkoutRequestID is required"
      });
    }

    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("checkout_request_id", checkoutRequestID)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.log("STATUS CHECK ERROR:", error.message);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    if (!data) {
      return res.json({
        success: true,
        found: false,
        status: "PENDING",
        message: "Payment not yet confirmed"
      });
    }

    return res.json({
      success: true,
      found: true,
      status: data.status || "PENDING",
      payment: data
    });
  } catch (err) {
    console.log("PAYMENT STATUS ERROR:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* ===================================================
   LOGIN CHECK
=================================================== */
app.post("/login", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.json({
        is_paid: false
      });
    }

    const { data, error } = await supabase
      .from("users")
      .select("is_paid")
      .eq("phone", phone)
      .maybeSingle();

    if (error || !data) {
      return res.json({
        is_paid: false
      });
    }

    return res.json({
      is_paid: data.is_paid
    });
  } catch (err) {
    return res.json({
      is_paid: false
    });
  }
});

/* ===================================================
   START SERVER
=================================================== */
app.listen(PORT, () => {
  console.log("=================================");
  console.log(`Server running on port ${PORT}`);
  console.log("=================================");
});