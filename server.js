
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

    res.json(response.data);

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
    console.log(
      JSON.stringify(req.body, null, 2)
    );

    const stk =
      req.body?.Body?.stkCallback;

    /* PAYMENT SUCCESS */
    if (stk?.ResultCode === 0) {

      const items =
        stk.CallbackMetadata?.Item || [];

      const phone =
        items.find(
          i => i.Name === "PhoneNumber"
        )?.Value;

      const amount =
        items.find(
          i => i.Name === "Amount"
        )?.Value;

      const receipt =
        items.find(
          i => i.Name === "MpesaReceiptNumber"
        )?.Value;

      /* SAVE PAYMENT */
      const { error } = await supabase
        .from("payments")
        .insert([
          {
            phone,
            amount,
            mpesa_receipt: receipt,
            status: "SUCCESS"
          }
        ]);

      if (error) {

        console.log(
          "PAYMENT SAVE ERROR:",
          error.message
        );

      } else {

        console.log(
          "PAYMENT SAVED ✅"
        );
      }

      /* UPDATE USER */
      const { error: userError } =
        await supabase
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

        console.log(
          "USER UPDATE ERROR:",
          userError.message
        );

      } else {

        console.log(
          "USER UPDATED ✅"
        );
      }

    } else {

      console.log(
        "PAYMENT FAILED:",
        stk?.ResultDesc
      );
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (err) {

    console.log(
      "CALLBACK ERROR:",
      err.message
    );

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
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

    const { data, error } =
      await supabase
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
  console.log(
    `Server running on port ${PORT}`
  );
  console.log("=================================");
});

