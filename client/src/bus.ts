// Tiny event bus between Phaser scenes and the DOM UI.

type Fn = (...args: any[]) => void;

class Bus {
  private m = new Map<string, Set<Fn>>();
  on(ev: string, fn: Fn) {
    let s = this.m.get(ev);
    if (!s) { s = new Set(); this.m.set(ev, s); }
    s.add(fn);
  }
  emit(ev: string, ...args: unknown[]) {
    for (const fn of this.m.get(ev) ?? []) fn(...args);
  }
}

export const bus = new Bus();
