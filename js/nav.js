// A* search over the 5 ft grid. Callers say which cells an agent may stand
// on and which steps between neighbor cells are allowed (fence crossings).

export class Nav {
  constructor(L) {
    this.L = L;
    const N = L.N;
    this.g = new Float32Array(N);
    this.came = new Int32Array(N);
    this.seen = new Uint32Array(N);   // generation stamp: g/came valid
    this.closed = new Uint32Array(N);
    this.gen = 0;
    this.heapF = new Float32Array(1 << 16);
    this.heapC = new Int32Array(1 << 16);
  }

  push(f, c) {
    if (this.size >= this.heapF.length) {
      const nf = new Float32Array(this.heapF.length * 2); nf.set(this.heapF); this.heapF = nf;
      const nc = new Int32Array(this.heapC.length * 2); nc.set(this.heapC); this.heapC = nc;
    }
    let i = this.size++;
    const F = this.heapF, C = this.heapC;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; C[i] = C[p]; i = p;
    }
    F[i] = f; C[i] = c;
  }
  pop() {
    const F = this.heapF, C = this.heapC;
    const top = C[0];
    const lf = F[--this.size], lc = C[this.size];
    let i = 0;
    for (;;) {
      let k = 2 * i + 1;
      if (k >= this.size) break;
      if (k + 1 < this.size && F[k + 1] < F[k]) k++;
      if (F[k] >= lf) break;
      F[i] = F[k]; C[i] = C[k]; i = k;
    }
    F[i] = lf; C[i] = lc;
    return top;
  }

  // opts: { passable(c), step(a, b) -> bool, isGoal(c), goalCell (for heuristic), maxExpand }
  // Returns the list of cells from start to goal (inclusive), or null.
  search(start, opts) {
    const L = this.L, cols = L.cols, rows = L.rows;
    const gen = ++this.gen;
    const { passable, step, isGoal, goalCell = -1, maxExpand = 200000 } = opts;
    const gcol = goalCell >= 0 ? goalCell % cols : 0, grow = goalCell >= 0 ? (goalCell - gcol) / cols : 0;
    const h = goalCell >= 0 ? (c) => {
      const dx = Math.abs((c % cols) - gcol), dy = Math.abs(Math.floor(c / cols) - grow);
      return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
    } : () => 0;
    this.size = 0;
    this.g[start] = 0; this.came[start] = -1; this.seen[start] = gen;
    this.push(h(start), start);
    let expanded = 0;
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    while (this.size > 0) {
      const c = this.pop();
      if (this.closed[c] === gen) continue;
      this.closed[c] = gen;
      if (isGoal(c)) {
        const out = [];
        for (let k = c; k !== -1; k = this.came[k]) out.push(k);
        return out.reverse();
      }
      if (++expanded > maxExpand) return null;
      const col = c % cols, row = (c - col) / cols;
      for (const [dc, dr, w] of DIRS) {
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const n = nr * cols + nc;
        if (this.closed[n] === gen || !passable(n)) continue;
        if (dc && dr) {
          // No corner cutting, and fence crossings only go straight.
          const a = row * cols + nc, b = nr * cols + col;
          if (!passable(a) || !passable(b) || !step(c, a) || !step(c, b) || !step(c, n)) continue;
        } else if (!step(c, n)) continue;
        const ng = this.g[c] + w;
        if (this.seen[n] !== gen || ng < this.g[n]) {
          this.seen[n] = gen; this.g[n] = ng; this.came[n] = c;
          this.push(ng + h(n), n);
        }
      }
    }
    return null;
  }
}
