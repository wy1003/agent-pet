# Codex 风格桌面宠物与 Petdex 一键导入开发说明

> 调研日期：2026-08-03  
> 本机验证版本：Codex Desktop `26.727.6591.0`（Windows）  
> 目标项目：Agent Pet

## 1. 结论与产品决策

本项目应当内置自己的宠物窗口和宠物资源库，不依赖 Codex 原生宠物窗口。这样用户使用 Codex、Claude Code、其他代码代理，甚至只运行本项目时，都能看到同一只宠物。

推荐的产品行为是：

1. 将当前的圆形任务徽标升级为宠物窗口，继续复用现有任务采集、任务面板、系统通知和语音提醒。
2. 宠物本身只负责形象、拖动、状态动画和打开任务面板，不再新增一套重复的消息气泡。
3. 用户在 Codex 设置里关闭 Codex 原生宠物，仅保留本项目宠物；这应作为引导提示，而不是程序自动修改 Codex 设置。
4. 本项目维护自己的位置和宠物库，不读写 Codex 的内部位置状态作为运行依赖。
5. Petdex 宠物默认只安装到本项目的受管宠物库；“同时安装到 Codex”作为可选复选框，默认关闭。

Codex 确实会在 `%USERPROFILE%\.codex\.codex-global-state.json` 中保存原生宠物位置，当前版本使用了 `electron-avatar-overlay-bounds` 等字段。但它是 Codex 私有状态，不是公开 API：字段可能变化，记录可能过期，也不能可靠表示宠物是否可见。因此，不应靠读取它把本项目 UI 放到 Codex 宠物旁边，更不应写入该文件。真正跨代理、可维护的方案就是在本项目中渲染宠物。

## 2. 调研边界与可信度

本文使用三类信息，后续实现时应区分它们：

| 标记 | 含义 | 如何使用 |
| --- | --- | --- |
| 公开契约 | Petdex README、CLI 文档公开承诺的 API 或包格式 | 可以作为集成边界，但仍要容错和版本化 |
| 当前实测 | 从本机已安装 Codex 版本的运行状态、资源结构和界面行为独立观察所得 | 用来复刻体验，不视为 OpenAI 稳定 API |
| 项目设计 | 针对 Agent Pet 的实现建议 | 是本项目应维护的正式契约 |

OpenAI 当前没有公开一份稳定的 Codex 宠物窗口开发 API。本文不建议调用 Codex 内部 IPC、修改 Codex 安装包或复制其内置宠物资源；实现应只兼容公开的自定义宠物包，并独立实现窗口和交互。

## 3. 目标体验

### 3.1 用户看到的行为

- 桌面上常驻一只透明背景宠物，默认约 `112 × 121` CSS 像素。
- 左键点击宠物：打开或关闭现有任务面板。
- 左键拖动宠物：跟手移动；水平方向移动时播放向左/向右跑动动画。
- 快速甩出：宠物带惯性滑行，碰到当前屏幕工作区边缘后衰减反弹。
- 悬停：可播放跳跃动画；开启“跟随鼠标视线”时，v2 宠物朝光标方向看。
- 右键：打开现有托盘式菜单，包含宠物选择、大小、置顶、Petdex、设置和退出。
- 任务运行、等待输入、完成或失败时切换相应动画；一次性反馈动画结束后回到待机。
- 宠物位置按显示器保存，拔掉显示器后自动回到可见屏幕。
- 用户可以从本地文件夹、现有 `~/.codex/pets`、现有 `~/.petdex/pets` 或 Petdex 在线目录添加宠物。

### 3.2 不做的事情

- 不控制 Codex 原生宠物。
- 不依赖 Codex 私有 IPC 或覆盖 Codex 全局状态文件。
- 不分发 Codex 内置宠物图像。
- 不把 Petdex 资源的 MIT 代码许可误当成每一只宠物素材的许可。
- 第一阶段不做宠物自动漫游、多个宠物同时存在和宠物间碰撞。

## 4. 总体架构

```text
Codex / Claude / 其他代理事件
              │
              ▼
现有 Collector + SSE ──► PetStateController ──► 宠物动画状态
              │                    │
              └──────────────► 现有任务面板/通知/语音

Petdex manifest ──► PetdexClient ──► PetImportService ──► 受管宠物库
本地宠物目录 ─────► PetPackageValidator ────────────────┘
                                                        │
                                                        ▼
PetWindowController ◄── PetRenderer + DragPhysics ◄── 当前宠物
        │
        └──► 现有 PanelWindow（不另建重复消息系统）
```

推荐继续使用两个透明窗口：

- `petWindow`：由当前 `badgeWindow` 演进而来，只包含宠物、数量角标和必要命中区域。
- `panelWindow`：继续使用现有任务列表窗口，按宠物所在屏幕选择左侧或右侧停靠。

Codex 当前版本把宠物和提示托盘组合到一个自适应透明覆盖窗口中。那种方式可以减少两个窗口同步误差，但会显著增加透明区域的鼠标穿透、动态测量和窗口裁剪复杂度。现有项目已经有稳定的双窗口结构，所以先保留双窗口，视觉和拖动仍可以做到一致。

### 4.1 现有项目差距

| 能力 | 当前项目 | 目标改造 |
| --- | --- | --- |
| 透明置顶窗口 | 已有 `badgeWindow` | 改名并演进为 `petWindow` |
| 任务详情 | 已有独立 `panelWindow` | 原样复用，只调整相对宠物的位置 |
| 拖动 | 已有 16ms 跟手移动和屏幕边界限制 | 增加 4px 判定、方向动画、速度采样、惯性和反弹 |
| 位置保存 | 只保存一个 `badgeBounds` | 升级为宠物锚点、显示器 ID 和分辨率回退 |
| 任务状态 | 已有 SSE、聚合状态和完整 task/phase | 新增纯状态映射层，不重复采集 |
| 宠物渲染 | 当前是 HTML/CSS 脸形徽标 | 新增 v1/v2 精灵动画渲染器 |
| 宠物资源 | 无受管宠物库 | 新增包校验、选择、删除、更新与来源记录 |
| Petdex | 未接入 | 新增 manifest client 和安全原子导入 |
| 消息提醒 | 已有任务面板、系统通知和语音 | 继续复用，不新增第二套消息气泡 |

## 5. Codex 兼容宠物包

### 5.1 目录结构

最小兼容包：

```text
<pet-id>/
├── pet.json
└── spritesheet.webp     # 也接受 spritesheet.png
```

Codex 当前可识别的最小元数据示例：

```json
{
  "id": "xiaobai",
  "displayName": "小白",
  "description": "让小白陪你工作",
  "spritesheetPath": "spritesheet.webp",
  "spriteVersionNumber": 2,
  "kind": "animal"
}
```

本项目解析时应遵循“已知字段严格校验，未知字段原样保留”：

- `id`：必填；目录安全 ID，建议只允许小写字母、数字、`-`、`_`，最长 64。
- `displayName`：必填或从 `id` 回退，最长 100。
- `description`：可选，最长 500。
- `spritesheetPath`：必填；只能是包目录内的相对文件名，拒绝绝对路径、`..` 和符号链接越界。
- `spriteVersionNumber`：缺省按 v1；仅接受 `1` 或 `2`。
- `kind`：展示信息，不用于决定执行权限。

### 5.2 精灵图规格

| 版本 | 网格 | 单帧 | 标准总尺寸 | 用途 |
| --- | --- | --- | --- | --- |
| v1 | 8 列 × 9 行 | 192 × 208 | 1536 × 1872 | 9 个基础动画状态 |
| v2 | 8 列 × 11 行 | 192 × 208 | 1536 × 2288 | 基础状态 + 16 个看向方向 |

Petdex CLI 还允许上述尺寸的干净整数缩放版本。为了与 Codex 保持一致，首版导入器可以接受整数缩放，但加载时必须依据实际宽高计算单元格，不能硬编码像素偏移。宽高必须分别能被 8 和 9/11 整除，单帧宽高比应为 `192:208`。

当前 Codex 基础行定义和有效帧数如下：

| 行 | 状态 | 有效帧数 | 说明 |
| ---: | --- | ---: | --- |
| 0 | `idle` | 6 | 待机 |
| 1 | `running-right` | 8 | 向右拖动 |
| 2 | `running-left` | 8 | 向左拖动 |
| 3 | `waving` | 4 | 完成、打招呼 |
| 4 | `jumping` | 5 | 悬停或成功反馈 |
| 5 | `failed` | 8 | 失败 |
| 6 | `waiting` | 6 | 等待用户回答 |
| 7 | `running` | 6 | 代理正在工作 |
| 8 | `review` | 6 | 等待批准或审阅 |
| 9 | `look-0..7` | 8 | v2 前 8 个方向 |
| 10 | `look-8..15` | 8 | v2 后 8 个方向 |

注意：Petdex 顶层 README 对动画行的文字说明比真实 Codex 兼容行更概括，且生态同时存在 v1/v2。实现必须依据 `spriteVersionNumber`、图像尺寸和上述兼容表验证，不能只照抄网页上的状态名称。

### 5.3 渲染公式

宠物 DOM 使用一个背景图元素：

```css
.pet-sprite {
  width: var(--pet-width, 112px);
  aspect-ratio: 192 / 208;
  background-repeat: no-repeat;
  image-rendering: pixelated;
}

.pet-sprite[data-version="1"] { background-size: 800% 900%; }
.pet-sprite[data-version="2"] { background-size: 800% 1100%; }
```

选择第 `column` 列、第 `row` 行时：

```text
xPercent = column / (columnCount - 1) × 100
yPercent = row / (rowCount - 1) × 100
```

然后设置 `background-position: xPercent% yPercent%`。不要逐帧裁图，浏览器只加载一张资源，切帧时只改背景位置。

为复刻 Codex 默认外观使用 `image-rendering: pixelated`。设置中可以额外提供“平滑缩放”，让非像素插画改用 `auto`；这个增强不影响包兼容性。

### 5.4 动画时序

当前版本实测时序：

| 状态 | 每帧时长（毫秒） |
| --- | --- |
| `idle` | `280, 110, 110, 140, 140, 320`，实际慢速待机循环再乘 6 |
| `running-right` | 前 7 帧 `120`，末帧 `220` |
| `running-left` | 前 7 帧 `120`，末帧 `220` |
| `waving` | 前 3 帧 `140`，末帧 `280` |
| `jumping` | 前 4 帧 `140`，末帧 `280` |
| `failed` | 前 7 帧 `140`，末帧 `240` |
| `waiting` | 前 5 帧 `150`，末帧 `260` |
| `running` | 前 5 帧 `120`，末帧 `220` |
| `review` | 前 5 帧 `150`，末帧 `280` |

一次性状态默认播放 3 轮，之后进入慢速 `idle`。持续工作状态可由 `PetStateController` 在仍有活动任务时再次触发。开启系统“减少动态效果”后，只显示该状态第一帧，不启动定时器。

动画调度建议使用 `performance.now()` + `requestAnimationFrame`，按累计时长计算当前帧，避免 `setInterval` 在窗口被阻塞后不断漂移。页面不可见时暂停，重新可见时从当前状态重新计时。

### 5.5 v2 看向光标

以宠物可见框中心为原点，计算光标向量；距离小于等于 1 像素时保留当前帧。将角度均分成 16 个 `22.5°` 扇区，方向 `0..7` 映射到第 9 行，`8..15` 映射到第 10 行。

看向状态优先级低于拖动、失败、完成和工作动画，仅在稳定待机时启用。由于 Codex 不同版本中此功能可能受开关影响，本项目应提供独立设置 `lookAtCursor`，默认可开启，但不能假设 Codex 会同步启用。

## 6. 宠物状态机

### 6.1 统一状态

```text
idle
running
waiting
review
waving
jumping
failed
dragging-left
dragging-right
```

状态优先级从高到低：

```text
拖动 > 一次性交互反馈 > 失败/完成反馈 > 任务聚合状态 > 看向光标 > idle
```

拖动结束后不要强行回到 `idle`，而是恢复拖动前由任务聚合器计算出的状态。

### 6.2 现有任务模型到宠物动画的映射

| 任务状态/阶段 | 宠物状态 | 规则 |
| --- | --- | --- |
| `running + tool_running/responding/reasoning` | `running` | 只要存在活动任务就持续 |
| `submitted/queued/waiting_start` | `waiting` | 等待代理开始 |
| `needs_input + waiting_approval` | `review` | 明确需要批准或审阅 |
| `needs_input + waiting_answer` | `waiting` | 等用户回答 |
| 新进入 `completed` | `waving` | 播放一次性 3 轮，然后按剩余任务恢复 |
| 新进入 `failed` | `failed` | 播放一次性 3 轮；同时保留现有通知 |
| 新进入 `interrupted/unknown` | `waiting` | 避免把中断都表现为严重失败 |
| 没有未确认任务 | `idle` | 慢速循环 |

多任务聚合建议：`needs_input` 优先于 `failed`，`failed` 优先于 `completed`，活动任务优先于纯待机。一次性动画只在状态边沿触发，不能因 SSE 快照重复而重复播放；键可以使用 `${taskId}:${status}`。

## 7. 窗口实现

### 7.1 BrowserWindow 配置

`petWindow` 建议配置：

```js
new BrowserWindow({
  show: false,
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  alwaysOnTop: preferences.appearance.alwaysOnTop,
  skipTaskbar: true,
  resizable: false,
  movable: true,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  hasShadow: false,
  focusable: false,
  webPreferences: {
    preload: PRELOAD_PATH,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
})
```

创建后调用：

- `setAlwaysOnTop(value, "floating")`
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
- 页面加载、资源解码和首帧布局完成后使用 `showInactive()`，避免白闪或抢焦点。

Codex 当前版本还明确关闭 Windows 圆角、厚边框和强调色。Electron 公共 API 对这些能力的覆盖随版本变化；先以透明无阴影窗口为基线，只有在实测出现系统边框时再添加平台专用处理。

### 7.2 窗口尺寸

- 默认宠物宽度：`112px`。
- 高度：`width × 208 / 192`，默认约 `121px`。
- 允许宽度范围：`80..224px`。
- 窗口应至少比可见宠物四周多 2–4px 透明余量，避免抗锯齿被裁切。
- 数量角标放在窗口内部右上角，不改变宠物的物理锚点。

`panelWindow` 继续使用现有 `panelBoundsNearBadge` 逻辑：优先显示在宠物左侧，不够则放到右侧，并限制在当前显示器 `workArea` 内。将函数改名为 `panelBoundsNearPet`，保留 `12px` 间距。

### 7.3 鼠标穿透

首版的宠物窗口本身与可见宠物尺寸接近，可以保持可交互。若以后扩大透明窗口容纳气泡，应对透明区域调用：

```js
petWindow.setIgnoreMouseEvents(true, { forward: true });
```

光标进入宠物或控件命中框时再恢复 `false`。所有按钮、任务卡片和菜单区域标记为 `.no-drag`；只有宠物可见区域启动拖动。

## 8. 与 Codex 一致的拖动与惯性

### 8.1 点击和拖动判定

1. 仅响应主键 `pointerdown`。
2. 记录指针屏幕坐标、窗口坐标、宠物在窗口中的矩形和 `pointerId`。
3. 调用 `setPointerCapture(pointerId)`。
4. 总移动距离小于 `4px` 时仍视为点击；达到 `4px` 才进入拖动。
5. 拖动后释放不能再触发“打开面板”。
6. `pointercancel`、`lostpointercapture`、窗口销毁和应用退出都必须终止拖动。

主进程要保存指针相对宠物左上角的锚点：

```text
pointerAnchorX = pointerWindowX - mascotRect.left
pointerAnchorY = pointerWindowY - mascotRect.top
petX = cursorScreenX - pointerAnchorX
petY = cursorScreenY - pointerAnchorY
```

这样用户抓住耳朵或身体的不同位置时不会跳动。现有项目按“初始窗口 + 光标总位移”的实现也不会反馈漂移，可以在第一阶段保留；加入可变窗口余量后再切换到宠物锚点公式。

### 8.2 跟手移动

- 主进程按约 `16ms` 更新一次窗口位置；也可以由 renderer 在 `pointermove` 时节流发送屏幕坐标。
- 用 `screen.getDisplayNearestPoint(cursor)` 确定当前显示器。
- 拖动过程中允许跨屏，进入新屏幕后立即使用新屏的 `workArea`。
- 水平位移为正时播放 `running-right`，为负时播放 `running-left`；小于 1px 的抖动沿用上一次方向。
- 拖动时 `panelWindow` 隐藏或同步重排；推荐隐藏，释放后再按新位置恢复，减少视觉抖动。

### 8.3 释放速度

只保留最近 `160ms` 的有效位置样本：

- 相邻样本时间差至少 `8ms`。
- 位移至少 `4px` 才纳入速度计算。
- 速度低于 `320px/s`：不启动惯性。
- 速度上限：`1600px/s`。

用最早和最新有效样本计算平均速度，比只用最后两个点更抗鼠标采样噪声。

### 8.4 惯性与边缘反弹

每 `16ms` 更新一次，单步 `dt` 最多按 `32ms` 计算：

```text
position += velocity × dtSeconds
velocity *= 0.88 ^ (dt / 16)
```

碰到 `workArea` 边界时把对应位置夹紧，并执行：

```text
velocityAxis = -velocityAxis × 0.7
```

满足任一条件即停止：

- 已运行 `900ms`；
- 总速度小于 `65px/s`；
- 窗口被隐藏或显示器配置变化后无法继续安全计算。

停止后重新计算面板位置，并在 `100ms` 防抖后持久化。用户再次按下宠物时立即取消当前惯性。

### 8.5 多屏与 DPI

- 全部位置计算使用 Electron 的 DIP 坐标，不自行乘 `scaleFactor`。
- 边界使用 `display.workArea`，不要使用包含任务栏的 `display.bounds`。
- 监听 `display-added`、`display-removed` 和 `display-metrics-changed`。
- 当前显示器移除时，立即把宠物夹到最近可用屏幕；不要等待用户重启。
- 恢复位置时优先匹配显示器 ID，再匹配分辨率；都不匹配则放在主屏右下角，边距 `24px`。

## 9. 本项目自己的位置状态

不要复用 Codex 的 `.codex-global-state.json`。建议把 `window-state.json` 升级为：

```json
{
  "version": 2,
  "pet": {
    "selectedPetId": "xiaobai",
    "width": 112,
    "displayId": "4060687382",
    "displayBounds": { "x": 0, "y": 0, "width": 2560, "height": 1440 },
    "anchor": { "x": 2362, "y": 1217 },
    "byDisplayId": {
      "4060687382": {
        "anchor": { "x": 2362, "y": 1217 },
        "displayBounds": { "x": 0, "y": 0, "width": 2560, "height": 1440 }
      }
    },
    "byResolution": {
      "2560x1440": { "anchor": { "x": 2362, "y": 1217 } }
    }
  }
}
```

保存宠物锚点而不是整个透明窗口矩形，未来扩大气泡或角标区域时位置不会漂移。写入采用“同目录临时文件 + rename”原子替换；JSON 损坏时回退默认位置，不影响启动。

## 10. Petdex 一键导入

### 10.1 可依赖的公开面

Petdex 当前公开说明：

- `https://petdex.dev/api/manifest` 返回已批准宠物的 slug、精灵图 URL、动画和元数据。
- 宠物包由根目录的 `pet.json` 与 `spritesheet.webp|png` 组成。
- `petdex install <slug>` 会写入 `~/.petdex/pets/<slug>/` 和 `~/.codex/pets/<slug>/`。
- CLI 安装路径本质是获取 JSON manifest 并写入两个文件。
- CLI 验证 v1 `8×9`、v2 `8×11` 以及它们的干净缩放版本。

本项目只把 manifest 与包格式当作集成点，不调用 Petdex 的登录、提交或桌面 hook。

### 10.2 为什么不在产品里执行 `npx petdex`

- 需要用户机器上存在合适的 Node/npm，并会出现安装确认和代理问题。
- 进度、取消、超时和错误信息难以稳定接入设置界面。
- CLI 会同时写入 Codex 宠物目录，可能产生用户担心的重复宠物。
- 难以在落盘前执行本项目需要的大小、路径、内容类型和许可校验。

开发调试时仍可以用 `npx -y petdex@latest install <slug>` 作为对照，但正式“一键添加”使用应用内导入器。

### 10.3 导入流程

```text
刷新目录
  │
  ├─ GET /api/manifest（10s 超时，ETag 缓存）
  │
选择宠物 / 输入 slug
  │
  ├─ 规范化 manifest 条目
  ├─ 下载 pet.json 与 sprite 到 staging
  ├─ 校验 URL、状态码、类型、大小、JSON、路径、图像尺寸
  ├─ 生成 SHA-256 与 source.json
  ├─ 原子 rename 到受管库
  └─ 切换当前宠物并预加载首帧
```

建议目录：

```text
%LOCALAPPDATA%\AgentPet\pets\<pet-id>\
├── pet.json
├── spritesheet.webp
└── source.json
```

`source.json` 是本项目扩展信息，不修改上游 `pet.json`：

```json
{
  "source": "petdex",
  "slug": "boba",
  "catalogUrl": "https://petdex.dev/pets/boba",
  "importedAt": "2026-08-03T00:00:00.000Z",
  "spriteSha256": "...",
  "license": null,
  "attribution": null,
  "manifestSnapshotVersion": null
}
```

manifest 的具体字段应由 `PetdexClient.normalizeEntry()` 隔离。UI 和安装服务只能消费本项目统一类型，避免 Petdex 增加或改名字段时波及整个应用。

### 10.4 安全与完整性校验

- 只接受 `https:`；开发模式显式配置时才允许 localhost HTTP。
- 默认只允许 Petdex manifest 返回的资源主机；重定向后重新校验最终 URL。
- manifest 响应上限建议 `10MB`，`pet.json` 上限 `64KB`，精灵图上限 `25MB`。
- 网络请求超时 `10s`，资源下载总超时 `30s`，支持 `AbortController` 取消。
- 只接受 JSON、PNG、WebP；同时检查文件魔数，不能只相信 `Content-Type` 或扩展名。
- 图像解码后验证网格、尺寸和透明通道；拒绝无法解码、超大像素和动画 WebP。
- `spritesheetPath` 必须解析在 staging 目录内。
- staging 使用随机目录；只有全部验证通过才原子安装。失败时清理 staging，旧版本保持可用。
- 相同 slug + 相同哈希显示“已安装”；相同 slug + 不同哈希显示“更新”，不要静默覆盖用户本地修改。
- 保存上游许可与署名信息。Petdex 代码是 MIT，不代表每只用户投稿宠物素材都是 MIT。

### 10.5 安装目标选项

设置界面提供：

- `添加到我的宠物`：默认且必选，写入本项目受管库。
- `同时安装到 Codex`：默认关闭，明确说明会复制到 `%USERPROFILE%\.codex\pets\<id>`，之后可在 Codex 外观设置中选择。
- 不需要写入 `~/.petdex/pets`，除非未来要与 Petdex Desktop 共用库；届时同样作为显式选项。

如果用户同时开启 Codex 原生宠物与本项目宠物，设置页显示一次非阻断提示：“桌面上可能出现两只宠物，可在 Codex → Settings → Appearance → Pets 中隐藏原生宠物。”不要自动编辑 Codex 状态。

### 10.6 本地导入和已有宠物发现

除在线 Petdex 外，提供三个入口：

1. `导入宠物文件夹`：复制并验证用户选中的目录。
2. `从 Codex 发现`：只读扫描 `%CODEX_HOME%\pets` 或 `%USERPROFILE%\.codex\pets`，用户确认后复制到受管库。
3. `从 Petdex Desktop 发现`：只读扫描 `%USERPROFILE%\.petdex\pets`，用户确认后复制。

不要让渲染器长期直接引用这些外部路径。复制到受管库能避免原文件移动、卸载或路径格式差异导致宠物突然消失。

## 11. IPC 与模块划分

### 11.1 建议新增文件

```text
desktop/pet/
├── pet-package.mjs          # 元数据规范化、路径与图片规格校验
├── pet-library.mjs          # 受管库枚举、选择、安装、删除、更新
├── petdex-client.mjs        # manifest 获取、缓存和条目规范化
├── pet-import-service.mjs   # 下载、staging、哈希、原子安装
├── pet-state-controller.mjs # 任务聚合状态与一次性动画去重
├── pet-window-controller.mjs# BrowserWindow、多屏、保存和面板定位
└── pet-drag-physics.mjs     # 速度采样、惯性、反弹，保持纯函数可测

public/
├── pet.html
├── pet.css
└── pet.js
```

现有文件调整：

- `desktop/main.mjs`：把窗口编排委托给 `PetWindowController`，不继续堆叠拖动和导入逻辑。
- `desktop/preload.cjs`：只暴露白名单 IPC。
- `desktop/preferences.mjs`：新增宠物设置并把配置版本升级。
- `desktop/window-layout.mjs`：保留通用几何函数，`badge` 命名迁移为 `pet`。
- `public/settings.*`：新增宠物库、Petdex 浏览、大小、动画和安装目标。
- `public/companion-badge.*`：第一阶段可直接改造成 `pet.*`，确认稳定后删除旧徽标资源。

### 11.2 建议 IPC

Renderer 不得直接访问文件系统或任意 URL：

```text
pet:list
pet:get-selected
pet:select                 { petId }
pet:import-folder          # 主进程打开目录选择器
pet:remove                 { petId }
petdex:list                { query?, cursor? }
petdex:install             { slug, installToCodex: false }
petdex:cancel-install      { operationId }
pet-window:pointer-down    { pointerId, screenX, screenY, localX, localY }
pet-window:pointer-move    { pointerId, screenX, screenY, time }
pet-window:pointer-up      { pointerId, screenX, screenY, time }
pet-window:toggle-panel
pet-window:show-menu
pet-renderer:ready         { mascotRect, spriteVersion }
pet-renderer:animation-end { state, generation }
```

每个 handler 都验证 `event.sender === petWindow.webContents` 或设置窗口的 `webContents`，并重新验证所有参数。路径由主进程选择或构造，renderer 不传任意目标路径。

## 12. 设置模型

建议把 `preferences.version` 从 8 升到 9，增加：

```json
{
  "appearance": {
    "showPet": true,
    "alwaysOnTop": true,
    "theme": "system",
    "pet": {
      "selectedPetId": "builtin-default",
      "width": 112,
      "renderMode": "pixelated",
      "hoverAnimation": true,
      "lookAtCursor": true,
      "reducedMotion": "system",
      "flingEnabled": true,
      "bounceEnabled": true
    }
  },
  "integrations": {
    "petdex": {
      "manifestUrl": "https://petdex.dev/api/manifest",
      "installToCodexByDefault": false
    }
  }
}
```

迁移时把旧 `appearance.showBadge` 映射为 `appearance.showPet`，旧位置继续读取一次并转换为新锚点。保留旧字段一个版本用于回滚兼容，之后再移除。

## 13. 分阶段开发计划

### 阶段 A：本地宠物与 Codex 风格拖动

- 用一只项目自有或用户提供的合法宠物替换现有 CSS 脸徽标。
- 完成 v1/v2 精灵渲染、状态机、点击与拖动。
- 完成速度采样、惯性、反弹、多屏恢复和位置迁移。
- 复用现有任务面板，不新增消息气泡。

验收：拖动阈值、甩动距离、边缘反弹和位置恢复在 100%、125%、150% DPI 下无明显差异；点击与拖动不会串事件。

### 阶段 B：宠物库与本地导入

- 实现包验证、受管宠物库、选择、删除和本地目录导入。
- 扫描 `.codex/pets` 与 `.petdex/pets`。
- 设置页显示静态预览、基本信息、规格和来源。

验收：合法 v1/v2 包可安装，损坏 JSON、越界路径、错误尺寸、半写入包均被拒绝；删除只删除受管副本。

### 阶段 C：Petdex 一键添加

- 接入 manifest、搜索、分页或本地过滤、缓存。
- 完成安全下载、进度、取消、更新和重试。
- 添加“同时安装到 Codex”显式选项和许可/署名展示。

验收：断网、超时、404、重定向、文件过大、哈希相同、同名不同内容、安装中退出都不破坏已有宠物。

### 阶段 D：跨代理与体验优化

- 将 Claude Code 等来源统一映射为相同任务事件，不把宠物逻辑绑定到 Codex 文件格式。
- 加入平滑渲染、减少动态效果、视线跟随和可选 hover 动画。
- 评估代码签名、自动更新和 Petdex manifest schema 变更监控。

## 14. 测试清单

### 14.1 单元测试

- 每个动画状态的行、帧数、时长和 v1/v2 背景坐标。
- 16 方向角度在 `0°/22.5°/360°` 边界的映射。
- 4px 点击/拖动阈值。
- 160ms 采样窗口、320/1600px/s 速度阈值。
- 16ms/32ms 时间步、0.88 衰减、0.7 反弹、65px/s 停止条件。
- 各种正负坐标显示器布局下的边界夹取和面板侧边选择。
- 状态聚合优先级和 `${taskId}:${status}` 一次性去重。
- `pet.json` 路径穿越、符号链接、尺寸、扩展名、魔数和大小限制。
- manifest 缺字段、未知字段、URL 变更和缓存回退。

### 14.2 集成测试

- 从现有 `companion-badge` 位置状态迁移。
- 导入后重启仍能加载当前宠物。
- SSE 断线/重连不会重复播放完成动画。
- 拖动期间任务状态改变，释放后恢复最新状态。
- 拔掉宠物所在显示器后窗口可见。
- 安装中断不会留下可枚举的半成品。
- `installToCodex=false` 时绝不写 `.codex/pets`。

### 14.3 手工视觉验收

- Windows 100%、125%、150%、200% 缩放。
- 单屏、左右副屏、上方副屏、负坐标布局。
- 任务栏在四个方向和自动隐藏。
- WebP/PNG、v1/v2、像素画/平滑插画。
- 快速点击、慢拖、快速甩、多次碰壁、惯性中再次抓取。
- 减少动态效果、置顶开关、显示/隐藏、全屏应用。

## 15. 已知风险与维护策略

1. **Codex 内部实现会变化。** 所有实测常量集中到 `pet-animation-profile.mjs` 和 `pet-drag-profile.mjs`，不要散落在 UI 中；以后可按体验调整，但不需要追随 Codex 私有字段。
2. **Petdex 文档与生态版本可能不同步。** 以包实测验证为准，manifest 经过 adapter，缓存中保存获取时间和响应版本。
3. **Windows 自定义宠物路径曾出现兼容问题。** 本项目统一使用主进程生成的受管绝对路径，并通过安全本地协议或转换后的文件 URL 交给 renderer，不拼接用户输入路径。
4. **精灵强制像素化不适合所有画风。** 默认匹配 Codex，另给用户平滑选项。
5. **素材版权不等于仓库代码许可。** 导入界面保留来源、作者、许可和下架信息；无法确认许可时不声称可再分发。
6. **双宠物重复。** 只能提示用户关闭 Codex 原生宠物，不能可靠或安全地自动关闭。

## 16. 开发时的关键检查点

- [ ] 不读写 Codex 原生宠物位置作为功能依赖。
- [ ] 不调用 Codex 内部 `pet-install`、`avatar-overlay` IPC。
- [ ] 自己渲染 `pet.json + spritesheet`，v1/v2 都可用。
- [ ] 当前徽标窗口演进为宠物窗口，任务面板和通知只保留一套。
- [ ] 拖动使用 4px 阈值，惯性参数集中配置并有纯函数测试。
- [ ] 位置按显示器保存，屏幕移除后保证可见。
- [ ] Petdex 正式导入不依赖 `npx`。
- [ ] 下载先进入 staging，验证成功后原子安装。
- [ ] 默认只写本项目宠物库；写 Codex 目录必须由用户显式选择。
- [ ] 保留 Petdex 来源、署名和许可字段。

## 17. 参考资料

- [Petdex 项目 README](https://github.com/crafter-station/petdex)
- [Petdex CLI README](https://github.com/crafter-station/petdex/blob/main/packages/petdex-cli/README.md)
- [Petdex 公共 manifest](https://petdex.dev/api/manifest)
- [Codex 自定义宠物路径与 WSL 兼容问题](https://github.com/openai/codex/issues/20730)
- [Codex 自定义宠物动画序列讨论](https://github.com/openai/codex/issues/20863)
- [Codex 宠物缩放与 `image-rendering` 讨论](https://github.com/openai/codex/issues/20808)
- [Codex v2 视线方向行为讨论](https://github.com/openai/codex/issues/34240)

本机实测还参考了当前安装包的宠物资源名称、透明窗口行为、精灵图布局和 `%USERPROFILE%\.codex\.codex-global-state.json`。这些内容只用于行为兼容和独立实现，没有把 Codex 内部源代码或内置宠物素材复制进本项目。
