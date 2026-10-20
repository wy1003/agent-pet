import { GIF_PET_STATES } from "./pet-library.mjs";

export const PET_DOWNLOAD_URL = "https://codex-pets.net/";

export function petConversionPrompt() {
  const states = Object.entries(GIF_PET_STATES)
    .map(([state, frames]) => `${state}：${frames} 帧`)
    .join("；");
  return [
    "请把我附上的宠物压缩包转换为 Agent Pet 可直接导入的「状态 GIF」ZIP，并提供转换后的 ZIP 文件。",
    "",
    "请检查源文件，保留原角色外观、动画和透明背景；等比例缩放并居中放置，不要拉伸或裁切角色。",
    "输出要求：",
    "1. ZIP 根目录只放状态 GIF，不嵌套文件夹，不附带其他文件。",
    "2. 文件统一命名为「英文前缀-状态.gif」，例如 my-pet-idle.gif；前缀须以英文字母或数字开头，只含英文字母、数字、短横线或下划线，最多 64 个字符。",
    "3. 每个 GIF 画布必须是 192×208 像素，背景透明，实际动画帧数须符合对应状态：",
    states,
    "4. 只转换源素材实际具有的状态，可提供 1 至 11 个不同状态，无需补齐缺失动作；有待机动画时优先保留 idle。",
    "5. ZIP 不超过 50 MB，单个 GIF 不超过 12 MB，解压后总大小不超过 64 MB。",
    "完成后检查文件名、画布尺寸、实际帧数和 ZIP 目录结构，避免 GIF 优化合并帧数；不要仅修改扩展名。若素材无法转换，请说明缺少什么。",
  ].join("\n");
}
