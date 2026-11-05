/* ============================================================
   workerPool.js — 모듈 워커 풀 (화면 쪽)
   ------------------------------------------------------------
   작업을 큐에 넣으면 빈 워커에 하나씩 보냅니다. 워커가 죽으면
   (메모리 부족 등) 그 작업만 실패 처리하고 새 워커로 계속합니다.
   ============================================================ */

import { getLang } from '../i18n/index.js';

export class WorkerPool {
  /**
   * @param {URL} url 워커 모듈 주소
   * @param {number} size 동시에 돌릴 워커 수
   * @param {(msg) => void} onMessage
   * @param {(jobId) => void} onCrash
   */
  constructor(url, size, onMessage, onCrash) {
    this.url = url;
    this.size = size;
    this.onMessage = onMessage;
    this.onCrash = onCrash;
    this.slots = [];
    this.queue = [];
  }

  /** 기기 코어 수에 맞춘 기본 크기 (큰 사진은 메모리를 많이 써서 최대 2개) */
  static defaultSize() {
    return (navigator.hardwareConcurrency || 2) >= 6 ? 2 : 1;
  }

  spawn() {
    const w = new Worker(this.url, { type: 'module' });
    const slot = { w, job: null };
    w.onmessage = (e) => {
      const msg = e.data;
      this.onMessage(msg);
      if (msg.type === 'done' || msg.type === 'error') { slot.job = null; this.pump(); }
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      const job = slot.job;
      w.terminate();
      this.slots.splice(this.slots.indexOf(slot), 1);
      if (job) this.onCrash(job.id);
      this.pump();
    };
    this.slots.push(slot);
    return slot;
  }

  /** 코덱을 미리 받아 둔다 (첫 장 대기 시간 단축) */
  preload(formats) {
    if (!this.slots.length) this.spawn();
    this.slots[0].w.postMessage({ type: 'preload', formats });
  }

  add(job) { this.queue.push(job); this.pump(); }
  cancel(id) { this.queue = this.queue.filter((j) => j.id !== id); }

  /** 대기 중이면 빼고, 이미 돌고 있으면 그 워커를 끝내 버린다(다음 작업은 새 워커로) */
  abort(id) {
    this.cancel(id);
    const slot = this.slots.find((s) => s.job && s.job.id === id);
    if (!slot) return;
    slot.w.terminate();
    this.slots.splice(this.slots.indexOf(slot), 1);
    this.pump();
  }

  /** 대기·실행 중인 작업이 있는지 */
  busy() { return this.queue.length > 0 || this.slots.some((s) => s.job); }

  pump() {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift();
      slot.job = job;
      // 워커는 화면 언어를 모르므로 작업마다 같이 보낸다 (안내·진행 문구를 그 언어로)
      slot.w.postMessage({ type: 'process', id: job.id, file: job.file, options: job.options, lang: getLang() });
    }
  }

  destroy() {
    this.queue = [];
    this.slots.forEach((s) => s.w.terminate());
    this.slots = [];
  }
}
