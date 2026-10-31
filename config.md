---
title: MCP 服务配置
description: MCP 客户端的连接策略与限额。服务器列表请在 Agent → MCP 标签页管理，启停由 Agent 侧的「启用 MCP 工具」决定
fields:
  - key: servers.autoConnect
    label: 启动时自动连接
    type: switch
    description: 服务就绪时自动连接已启用的服务器；关闭后需要手动点连接，掉线也不再自动重连
    default: true

  - key: servers.reconnectDelayMs
    label: 重连退避基数
    type: number
    description: 掉线后按指数退避重连，上限 30 秒（毫秒）
    placeholder: "2000"
    default: 2000

  - key: servers.maxConcurrency
    label: 并发调用上限
    type: number
    description: 同时进行的 tools/call 数量。stdio 服务器是单进程，不建议调高
    placeholder: "4"
    default: 4

  - key: servers.maxTools
    label: 工具表条目上限
    type: number
    description: 全部服务器合计。溢出的工具进系统提示词目录，仍可用 mcp_call 调用；0 表示不限制
    placeholder: "64"
    default: 64

  - key: servers.maxResultChars
    label: 结果文本上限
    type: number
    description: 单个 MCP 工具结果的字符数上限，超出会截断并附说明
    placeholder: "20000"
    default: 20000

  - key: servers.maxResultImages
    label: 单次结果图片上限
    type: number
    description: 超过上限的图片会被丢弃并留下占位说明
    placeholder: "4"
    default: 4
---
