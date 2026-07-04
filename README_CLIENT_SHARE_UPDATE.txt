CLIENT SHARE UPDATE - WHAT IS INCLUDED

1. server.js is now the active backend used by package.json (npm start -> node server.js).
2. Share link API is included:
   - POST action createVesselShareLink via /api
   - GET /share/:token
   - GET /api/share/:token
3. Client portal files are included at project root and in public/:
   - share.html
   - share.js
   - share.css
4. The normal file list no longer shows the Excel button/column.
5. The user access notice banner was removed.

HOW TO RUN LOCALLY

1. Open CMD.
2. cd /d "YOUR_PROJECT_FOLDER"
3. npm install
4. npm start
5. Open http://localhost:3000

RENDER DEPLOY

1. Upload this complete project to Render/GitHub.
2. Build command: npm install
3. Start command: npm start
4. Ensure environment variables are added in Render:
   MONGODB_URI
   MONGODB_DB
   PORT is optional; Render provides it automatically.

IMPORTANT

Generate client share links from the deployed Render website, not from localhost. A link created locally will not exist in the Render database unless both use the same MongoDB database.
