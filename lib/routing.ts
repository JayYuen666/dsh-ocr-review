// lib/routing.ts —— systemPrompt 路由段：教模型四个 ocr_* 工具何时用。
// order 1555（紧邻 zg 1550 之后、lesson-loop 1560 之前；修撞车：
// 原 1560 与 lesson-loop SECTION_ORDER 同值，同 order 按名称稳定排序但仍属
// 语义混层，官方约定 order 递增分层）。文本精简、只讲路由与坑，细节放进工具描述。
//
// 正文不在此文件：注入段是给模型看的文案，中英两份都在 lib/messages.ts 的
// MESSAGES 里（host.ts 按官方 locale 偏好取一份传进 systemPrompt.section）。
// 这里只留命名空间与 order 这两个与文案无关的常量。

export const ROUTING_NAME = "ocr-review-routing";
export const ROUTING_ORDER = 1555;
