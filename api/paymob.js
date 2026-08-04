// Vercel Serverless Function for Paymob Payment Link Generation
// Handles Paymob Auth Token -> Order Registration -> Payment Key -> Iframe URL

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed. Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    
    const price = parseFloat(body.price);
    const expirationIso = body.expirationDate;
    const studentName = (body.studentName || 'Student').trim();
    const studentContact = (body.studentContact || '').trim();
    const description = (body.description || 'Z-English Course Access').trim();

    const apiKey = body.apiKey || process.env.PAYMOB_API_KEY || 'ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SmpiR0Z6Y3lJNklrMWxjbU5vWVc1MElpd2ljSEp2Wm1sc1pWOXdheUk2TVRJd09UY3hNQ3dpYm1GdFpTSTZJbWx1YVhScFlXd2lmUS56N096Rktoc01jWDZPd2d0NFR3U051Ylg1czRDTGRPWmltYUtNbzNvbERkMm5BSW0yS1JWNEZ0S2U4WnNrczk4MXlaeVY4Qk4zcEV2a21GQlNKYXdvZw==';
    const integrationId = body.integrationId || process.env.PAYMOB_INTEGRATION_ID || '5818041';
    const iframeId = body.iframeId || process.env.PAYMOB_IFRAME_ID || '1066378';

    if (isNaN(price) || price <= 0 || !expirationIso) {
      return res.status(400).json({ success: false, message: 'Invalid price or expiration date.' });
    }

    const expirationDate = new Date(expirationIso);
    const priceCents = Math.round(price * 100);

    // Step 1: Obtain Auth Token from Paymob
    const authResp = await fetch('https://accept.paymob.com/api/auth/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey })
    });
    const authData = await authResp.json();
    const authToken = authData.token;

    if (!authToken) {
      return res.status(400).json({ success: false, message: 'Failed to authenticate with Paymob. Check API Key.', details: authData });
    }

    // Step 2: Register Order with Paymob
    const orderResp = await fetch('https://accept.paymob.com/api/ecommerce/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: authToken,
        delivery_needed: "false",
        amount_cents: String(priceCents),
        currency: "EGP",
        items: []
      })
    });
    const orderData = await orderResp.json();
    const orderId = orderData.id;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Failed to create Paymob order.', details: orderData });
    }

    // Step 3: Generate Payment Key
    const keyResp = await fetch('https://accept.paymob.com/api/acceptance/payment_keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_token: authToken,
        amount_cents: String(priceCents),
        expiration: Math.max(60, Math.floor((expirationDate.getTime() - Date.now()) / 1000)),
        order_id: String(orderId),
        billing_data: {
          apartment: "NA",
          email: studentContact.includes('@') ? studentContact : "student@z-english.online",
          floor: "NA",
          first_name: studentName.split(' ')[0] || "Student",
          street: "NA",
          building: "NA",
          phone_number: !studentContact.includes('@') && studentContact ? studentContact : "01000000000",
          shipping_method: "NA",
          postal_code: "NA",
          city: "Cairo",
          country: "EG",
          last_name: studentName.split(' ').slice(1).join(' ') || "User",
          state: "NA"
        },
        currency: "EGP",
        integration_id: Number(integrationId)
      })
    });
    const keyData = await keyResp.json();

    if (!keyData.token) {
      return res.status(400).json({ success: false, message: 'Failed to obtain Paymob payment key.', details: keyData });
    }

    const paymentUrl = iframeId
      ? `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${keyData.token}`
      : `https://accept.paymob.com/standalone?payment_token=${keyData.token}`;

    return res.status(200).json({
      success: true,
      paymentUrl: paymentUrl,
      paymentToken: keyData.token,
      orderId: orderId
    });

  } catch (err) {
    console.error('Vercel Paymob API Error:', err);
    return res.status(500).json({ success: false, message: 'Server Error: ' + err.message });
  }
};
