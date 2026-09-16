# OmniRoute ChatGPT Companion Extension

> **Free ChatGPT Web Tokens in your local coding environment:** Stream responses directly from your authenticated ChatGPT Web tab (Plus, Pro, Team, Enterprise) into OmniRoute at **$0 API cost** with 100% Cloudflare Turnstile immunity.

---

## 🚀 How to Install and Use

### 1. Load the Extension in Chrome
1. Open Google Chrome (or Edge/Brave).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** (Cargar descomprimida).
5. Select this folder:
   ```
   /Users/javargasm91/Laboral/Personal/repos/OmniRoute/extensions/chatgpt-companion
   ```

### 2. Open ChatGPT Web
1. Open a new tab and navigate to [https://chatgpt.com](https://chatgpt.com).
2. Make sure you are logged in with your regular account.
3. Click the **OmniRoute Companion** extension icon in your Chrome toolbar.
4. You should see:
   - **OmniRoute Server:** `🟢 Connected` (pointing to `http://127.0.0.1:20128`)
   - **ChatGPT Tab:** `🟢 Ready`

### 3. Route Any Request via OmniRoute
Now you can use any model through OmniRoute using your ChatGPT Web subscription:

```bash
curl -N http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-omniroute-key>" \
  -d '{
    "model": "chatgpt-web-companion/gpt-5.6-sol",
    "messages": [
      {"role": "user", "content": "Write a quick Rust CLI example"}
    ],
    "stream": true
  }'
```

### 4. Use with Codex CLI, Cursor or OpenCode
Set your base URL to `http://localhost:20128/v1` and use model `chatgpt-web-companion/gpt-5.6-sol` or `cgpt-companion/o3`. All generation runs on your web plan with zero API billing!
