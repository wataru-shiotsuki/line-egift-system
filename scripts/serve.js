require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, '../public')));
app.use('/webhook', require('../api/webhook'));
app.use('/stripe-webhook', require('../api/stripe-webhook'));
app.use(require('../api/app'));

app.listen(Number(process.env.PORT) || 3000, () => {
  console.log(`Giftalk listening on port ${process.env.PORT || 3000}`);
});
