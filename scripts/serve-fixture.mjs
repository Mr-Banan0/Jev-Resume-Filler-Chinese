// 把离线自测页挂在 http://127.0.0.1:8765/，
// 这样扩展不需要"允许访问文件网址"就能注入。
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { extname, join, normalize } from "path";

const ROOT = new URL("../tests/fixture/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8765);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "honor-form.html" : urlPath.replace(/^\/+/, "");
  const target = normalize(join(ROOT, rel));

  // 防目录穿越
  if (!target.startsWith(normalize(ROOT))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404 ${rel}`);
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(target)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(readFileSync(target));
});

server.listen(PORT, HOST, () => {
  console.log(`离线自测页已启动： http://${HOST}:${PORT}/`);
  console.log("打开上面的地址，点扩展图标 → 「测试 content script 注入」即可看到控件清单。");
  console.log("按 Ctrl+C 结束。");
});
