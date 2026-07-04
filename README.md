# Coral Marine VMMS

This is a Node.js + Express app for vessel manual management with Google Drive PDF uploads.

## What is saved and where

- `data.json` stores:
  - users
  - vessels
  - folder structure
  - file metadata
- PDF files are uploaded to Google Drive under the configured root folder:
  - `DRIVE_ROOT_FOLDER_ID` in `app.js`
- The app metadata is persisted locally on the server in `data.json`.

## Local run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the project root with your MongoDB Atlas connection:
   ```env
   MONGODB_URI=mongodb+srv://sanchitd66_db_user:Sanchit152007@cluster0.dkrotcu.mongodb.net/?appName=Cluster0
   MONGODB_DB=vmms
   PORT=3000
   ```
3. Start the app:
   ```bash
   npm start
   ```
4. Open:
   ```
   http://localhost:3000
   ```

## Hosting

This app can be hosted on any Node.js-compatible platform.

### Shared database configuration

This version supports shared metadata storage through MongoDB Atlas.

1. Create a free MongoDB Atlas cluster.
2. Create a database user and allow access from your host IP or `0.0.0.0/0` for development.
3. Copy the connection string URI and set it as an environment variable or add it to a `.env` file in the project root:
   - `MONGODB_URI`
   - optionally `MONGODB_DB` (default: `vmms`)
4. Deploy the project folder to a Node host (Render, Railway, DigitalOcean App Platform, etc.).
5. Ensure `PORT` is available and the host uses `process.env.PORT` (already in `server.js`).
6. If `MONGODB_URI` is configured, the app will attempt Atlas storage and will abort startup if Atlas is unreachable.
7. Update the Google OAuth client settings for the deployed domain:
   - Add the deployment URL as an authorized JavaScript origin in Google Cloud Console.
   - Use the same `GOOGLE_CLIENT_ID` in `app.js`.
8. If you want to use a different domain, update `GOOGLE_CLIENT_ID` to the OAuth client for that project.

### Notes

- `data.json` is now only a local fallback if `MONGODB_URI` is not configured.
- For shared data across machines, make sure `MONGODB_URI` is set and Atlas is available.
- PDF files still upload to Google Drive, while metadata is stored in MongoDB.

## Important notes

- The actual PDF documents are stored in Google Drive, not on the app server.
- If you deploy to a new server and do not copy `data.json`, the new app instance will start with an empty metadata store.
- For a client deployment, send the full project folder plus `data.json` if you want existing metadata to carry over.

## Troubleshooting

- If uploads fail with `DOMAIN NOT CONFIGURED`, ensure your hosted origin is added in the OAuth client settings.
- If you see `querySrv ECONNREFUSED`, your machine cannot resolve Atlas SRV DNS. Use Atlas's standard `mongodb://...` connection string or allow DNS traffic, then restart.
- If the app reports `EADDRINUSE`, another process already uses port `3000`. Run `netstat -ano | findstr :3000` and stop the process, or set `PORT` to a free port before restarting.
- If `MONGODB_URI` is configured and Atlas cannot connect, the server will now abort startup instead of silently using local `data.json`.

## Quick summary

- `data.json` = metadata storage
- Google Drive = PDF content storage
- host domain must be authorized in Google OAuth client
- include `data.json` when deploying to preserve current data
