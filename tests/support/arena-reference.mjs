// Движок правил «Точек» (spec/dots/v1.md). Без зависимостей, работает в Node и в браузере.
// Цвета: 1 = red (ходит первым), 2 = blue. Координаты: x вправо, y вниз, от 0.

export const RED = 1;
export const BLUE = 2;
export const NAME = { 1: 'red', 2: 'blue' };
export const COLOR = { red: RED, blue: BLUE };
export const opp = (c) => 3 - c;

export class DotsGame {
  constructor(width = 100, height = 100) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1e6) throw new Error('bad field size');
    this.w = width;
    this.h = height;
    this.owner = new Uint8Array(width * height);
    this.dead = new Uint8Array(width * height);
    this.order = []; // индексы клеток в порядке постановки
    this.turn = RED;
    this.last = null;
    this._queue = new Int32Array(width * height);
  }

  clone() {
    const g = new DotsGame(this.w, this.h);
    g.owner.set(this.owner);
    g.dead.set(this.dead);
    g.order = this.order.slice();
    g.turn = this.turn;
    g.last = this.last ? [...this.last] : null;
    return g;
  }

  idx(x, y) { return y * this.w + x; }
  inField(x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.w && y < this.h; }
  isFree(x, y) { return this.inField(x, y) && this.owner[this.idx(x, y)] === 0; }
  get freeCount() { return this.w * this.h - this.order.length; }
  get full() { return this.freeCount === 0; }

  /**
   * Клетки, окружённые живыми точками цвета c: области связности по 4 направлениям среди клеток без живой точки c,
   * из которых нельзя выйти за край поля. Диагональная цепочка точек c области разделяет.
   */
  enclosed(c) {
    const { w, h, owner, dead } = this;
    const n = w * h;
    const wall = (i) => owner[i] === c && !dead[i];
    const seen = new Uint8Array(n);
    const q = this._queue;
    let head = 0;
    let tail = 0;
    const push = (i) => { if (!seen[i] && !wall(i)) { seen[i] = 1; q[tail++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!seen[i] && !wall(i)) out[i] = 1;
    return out;
  }

  /** Пересчёт захватов до стабилизации. Возвращает изменения [{x,y,color,dead}] */
  _settle() {
    const { owner, dead, w } = this;
    const changes = new Map();
    const note = (i, state) => {
      const prev = changes.get(i);
      if (prev === undefined) changes.set(i, state);
      else if (prev !== state) changes.delete(i); // вернулось в исходное
    };
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const c of [RED, BLUE]) {
        const enc = this.enclosed(c);
        const victim = opp(c);
        for (let i = 0; i < owner.length; i++) {
          if (owner[i] !== victim) continue;
          if (enc[i] && !dead[i]) { dead[i] = 1; note(i, 1); changed = true; }
          else if (!enc[i] && dead[i]) { dead[i] = 0; note(i, 0); changed = true; }
        }
      }
      if (!changed) break;
    }
    return [...changes].map(([i, state]) => ({ x: i % w, y: (i - (i % w)) / w, color: owner[i], dead: !!state }));
  }

  /** Ход цвета color (по умолчанию — очередного игрока) */
  play(x, y, color = this.turn) {
    if (!this.inField(x, y)) return { ok: false, reason: 'out_of_field' };
    const i = this.idx(x, y);
    if (this.owner[i] !== 0) return { ok: false, reason: 'occupied' };
    this.owner[i] = color;
    this.order.push(i);
    this.last = [x, y];
    const changes = this._settle();
    this.turn = opp(color);
    return { ok: true, changes, killed: changes.filter((c) => c.dead), revived: changes.filter((c) => !c.dead) };
  }

  /** Счёт цвета = число мёртвых точек противника */
  scoreOf(c) {
    let s = 0;
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === opp(c) && this.dead[i]) s++;
    return s;
  }
  get score() { return { red: this.scoreOf(RED), blue: this.scoreOf(BLUE) }; }

  /** Позиция в формате протокола (spec/dots/v1.md, раздел 3.1) */
  snapshot() {
    const points = { red: [], blue: [] };
    const dead = { red: [], blue: [] };
    for (const i of this.order) {
      const x = i % this.w;
      const cell = [x, (i - x) / this.w];
      const name = NAME[this.owner[i]];
      points[name].push(cell);
      if (this.dead[i]) dead[name].push(cell);
    }
    return { field: { width: this.w, height: this.h }, points, dead, score: this.score, last: this.last };
  }

  /** Свободные клетки в порядке строк */
  freeCells() {
    const out = [];
    for (let i = 0; i < this.owner.length; i++) if (!this.owner[i]) out.push([i % this.w, (i - (i % this.w)) / this.w]);
    return out;
  }

  /** Восстановить партию из последовательности ходов [[x,y], ...] (red, blue, red, …) */
  static fromMoves(width, height, moves) {
    const g = new DotsGame(width, height);
    for (const [x, y] of moves) {
      const r = g.play(x, y);
      if (!r.ok) throw new Error(`bad move ${x},${y}: ${r.reason}`);
    }
    return g;
  }
}
