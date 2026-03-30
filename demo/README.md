# Demo Pages

Run the local demo server:

```bash
node demo/server.mjs
```

Then open the extension sidepanel and click `预审 Demo`.

The fixed demo flow will:

1. Open `http://127.0.0.1:4180/demo/review-list.html`
2. Pick the first pending case
3. Open the case detail page
4. Extract attachment links
5. Send a fixed analysis prompt to the `demo-pre-review` session in OpenClaw
6. Wait for the latest assistant reply in that session
7. Open `http://127.0.0.1:4180/demo/review-result.html` and render the extracted data plus the analysis result
