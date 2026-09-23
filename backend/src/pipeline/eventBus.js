import { EventEmitter } from 'node:events'

// Pub/sub tiến trình pipeline cho SSE (docs/06 §2.2).
// runner.js emit → routes/v1/events.js subscribe theo projectId.
// ARCHITECTURE: process-local EventEmitter (best-effort realtime). Nếu API và
// worker chạy khác process, event có thể không tới client — frontend PHẢI coi DB
// polling (GET project/jobs) là authoritative fallback, SSE chỉ để cập nhật nhanh.
// Không rewrite sang Redis pub/sub trong đợt này (giữ queue infra nguyên).
class PipelineEventBus extends EventEmitter {
  publish(projectId, payload) {
    this.emit(`project:${projectId}`, payload)
  }

  subscribe(projectId, listener) {
    const channel = `project:${projectId}`
    this.on(channel, listener)
    return () => this.off(channel, listener)
  }
}

const bus = new PipelineEventBus()
bus.setMaxListeners(100)

export default bus
