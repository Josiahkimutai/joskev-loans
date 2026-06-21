const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ================= ENV ================= */
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  SUPABASE_URL,
  SUPABASE_KEY
} = process.env;

/* ================= SUPABASE ================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ================= HOME ================= */
app.get("/", (req, res) => {
  res.send("M-Pesa Server Running 🚀");
});

/* ================= ACCESS TOKEN ================= */
async function getAccessToken() {
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
}

/* ================= STK PUSH ================= */
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "Phone and amount required" });
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
      AccountReference: "LOAN_APP",
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

    const stkData = response.data;

    console.log("STK RESPONSE:", stkData);

    // save pending payment immediately
    if (stkData.CheckoutRequestID) {
      await supabase.from("payments").insert([
        {
          phone,
          amount: Number(amount),
          checkout_request_id: stkData.CheckoutRequestID,
          merchant_request_id: stkData.MerchantRequestID,
          status: "PENDING",
          message: "Waiting for callback"
        }
      ]);
    }

    res.json(stkData);

  } catch (err) {
    console.log("STK ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ================= CALLBACK (FIXED) ================= */
app.post("/callback", async (req, res) => {
  try {
    console.log("CALLBACK RECEIVED:", JSON.stringify(req.body, null, 2));

    const stk = req.body?.Body?.stkCallback;

    if (!stk) {
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const checkoutRequestID = stk.CheckoutRequestID;
    const merchantRequestID = stk.MerchantRequestID;
    const resultCode = stk.ResultCode;
    const resultDesc = stk.ResultDesc;

    const items = stk.CallbackMetadata?.Item || [];

    const phone = items.find(i => i.Name === "PhoneNumber")?.Value || null;
    const amount = items.find(i => i.Name === "Amount")?.Value || null;
    const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;
    const transactionDate = items.find(i => i.Name === "TransactionDate")?.Value || null;

    const success = resultCode === 0;

    const paymentData = {
      phone,
      amount,
      mpesa_receipt: receipt,
      transaction_date: transactionDate ? String(transactionDate) : null,
      checkout_request_id: checkoutRequestID,
      merchant_request_id: merchantRequestID,
      status: success ? "SUCCESS" : "FAILED",
      result_code: resultCode,
      result_desc: resultDesc,
      message: success ? "Payment successful" : resultDesc
    };

    // UPSERT = SAFE (no duplicates, no missing rows)
    const { error } = await supabase
      .from("payments")
      .upsert(paymentData, {
        onConflict: "checkout_request_id"
      });

    if (error) {
      console.log("CALLBACK ERROR:", error.message);
    } else {
      console.log("PAYMENT SAVED ✅");
    }

    // update user if success
    if (success && phone) {
      await supabase.from("users").upsert(
        { phone, is_paid: true },
        { onConflict: "phone" }
      );
    }

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

/* ================= PAYMENT STATUS ================= */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data } = await supabase
      .from("payments")
      .select("*")
      .eq("checkout_request_id", id)
      .maybeSingle();

    if (!data) {
      return res.json({
        success: true,
        found: false,
        status: "PENDING",
        message: "Waiting for payment"
      });
    }

    return res.json({
      success: true,
      found: true,
      status: data.status,
      payment: data
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* ================= LOGIN ================= */
app.post("/login", async (req, res) => {
  try {
    const { phone } = req.body;

    const { data } = await supabase
      .from("users")
      .select("is_paid")
      .eq("phone", phone)
      .maybeSingle();

    return res.json({
      is_paid: data?.is_paid || false
    });

  } catch (err) {
    return res.json({ is_paid: false });
  }
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});