# dsh-hik-view

在 DSH web GUI 里实时查看海康威视 NVR 摄像头。宿主侧通过 ffmpeg 把 NVR 的
RTSP（H.265）流转码成浏览器可直接显示的 MJPEG；客户端侧注册一个单例底部面板
标签页（「实时视频」），支持通道切换、帧率档位与自动重连。

## 路由

| 路由 | 用途 |
| --- | --- |
| `GET /hik-view/api/info` | 通道列表、画质/路数上限、活跃会话 |
| `GET /hik-view/stream?ch=<id>&fps=&q=` | MJPEG 流（`multipart/x-mixed-replace`） |
| `POST /hik-view/api/client-log` | 客户端生命周期诊断上报到宿主日志 |

所有路由与 `/api` 网关走同一道浏览器信任栅栏（loopback 或受信 host、同站），
因此视频流和 GUI 走相同的中继链路（含 frp/VPS 远程反代）。

## 中继安全性

- 每个通道一个 ffmpeg 子进程；新观众会**替换**同通道的残留会话，泄漏的观看
  者永远不会卡死通道；全局并发上限 `stream.maxStreams` 约束转码总量。
- 浏览器断开时先 SIGTERM（ffmpeg 发 RTSP TEARDOWN，NVR 立即释放通道槽位），
  2s 后 SIGKILL 兜底；15s 无帧的僵死管线由空闲看门狗释放。
- 0.1.1 修复了一个会打死整个进程的中断竞态：观看者断开后，在途帧写到已结束
  的响应上会以未处理 `ERR_STREAM_WRITE_AFTER_END` 的形式**退出整个 DSH web
  进程**。现在拆除时会先 `unpipe` 并挂上响应 `error` 监听，观看者断开不再
  影响宿主。

## 配置

配置来自包内 `cordis.patch.yml` 的 insert。**NVR 密码刻意不入库**——在目标
宿主上用 profile 层 patch 覆盖（在 bundle 层之后生效）：

```yaml
# <DSH_HOME>/profiles/web/cordis.patch.yml
- id: hik-view
  config:
    nvr:
      password: <secret>
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `nvr.host` / `port` / `user` | `10.18.7.191:554` / `admin` | NVR RTSP 端点 |
| `channels[]` | cam1–cam4，子码流 102/202/302/402 | 海康 `Streaming/Channels/<sub>` 通道号 |
| `stream.fps` | `8` | 1–25，观看者可用 `?fps=` 临时覆盖 |
| `stream.quality` | `12` | ffmpeg `-q:v`，2（最好）– 31 |
| `stream.maxWidth` | `640` | 缩放上限（ARM CPU + 上行带宽保护） |
| `stream.maxStreams` | `4` | 并发 ffmpeg 子进程数 |

宿主 `PATH` 上需要有 `ffmpeg`（openEuler：`dnf install ffmpeg`）。
