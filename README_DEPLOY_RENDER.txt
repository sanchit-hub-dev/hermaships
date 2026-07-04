DEPLOY TO RENDER

1. Upload this folder contents to GitHub root. Do not upload the outer folder only.
2. Render Web Service settings:
   Build Command: npm install
   Start Command: node server.js
3. Add Render environment variables:
   MONGODB_URI
   MONGODB_DB=vmms
   JWT_SECRET
4. Login credentials after deploy:
   Admin: Coral / Coral2026
   User: herma_shipping / ABS2026
5. Client share links work at:
   https://your-render-domain.onrender.com/share/<token>
