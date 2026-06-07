require("dotenv").config();

const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const app = express();

app.use(cors());
app.use(express.json());

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const otpStore = {};

// SEND OTP
app.post("/send-otp", async (req, res) => {

    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({
            success: false,
            message: "Phone number is required"
        });
    }

    const otp = Math.floor(
        100000 + Math.random() * 900000
    ).toString();

    otpStore[phone] = {
        otp,
        createdAt: Date.now()
    };

    try {

        await client.messages.create({
            body: `Your Joskev Loans OTP is ${otp}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone
        });

        return res.json({
            success: true,
            message: "OTP sent successfully"
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Failed to send OTP"
        });
    }
});

// VERIFY OTP
app.post("/verify-otp", (req, res) => {

    const { phone, otp } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({
            success: false,
            message: "Phone and OTP required"
        });
    }

    const record = otpStore[phone];

    if (!record) {
        return res.json({
            success: false,
            message: "OTP expired or not found"
        });
    }

    // 5 minutes expiry
    const expired =
        Date.now() - record.createdAt >
        5 * 60 * 1000;

    if (expired) {

        delete otpStore[phone];

        return res.json({
            success: false,
            message: "OTP expired"
        });
    }

    if (record.otp !== otp) {
        return res.json({
            success: false,
            message: "Invalid OTP"
        });
    }

    delete otpStore[phone];

    return res.json({
        success: true,
        message: "OTP verified"
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});