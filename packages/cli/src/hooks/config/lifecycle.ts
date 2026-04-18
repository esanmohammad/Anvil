// Section I — Hook Lifecycle
import { installHooks, removeHooks } from './installer.js';
import type { FsAdapter } from './installer.js';
import type { GeneratorOptions } from './generator.js';

export interface HookLifecycleOptions {
  projectRoot: string;
  generatorOptions?: GeneratorOptions;
  fs?: FsAdapter;
}

export class HookLifecycle {
  private projectRoot: string;
  private options: GeneratorOptions;
  private fs?: FsAdapter;
  private installed = false;

  constructor(opts: HookLifecycleOptions) {
    this.projectRoot = opts.projectRoot;
    this.options = opts.generatorOptions ?? {};
    this.fs = opts.fs;
  }

  /**
   * Auto-install hooks on Engineer start.
   */
  onStart(): void {
    if (this.installed) return;
    if (this.fs) {
      installHooks(this.projectRoot, this.options, this.fs);
    } else {
      installHooks(this.projectRoot, this.options);
    }
    this.installed = true;
  }

  /**
   * Remove hooks when done.
   */
  onDone(): void {
    if (!this.installed) return;
    if (this.fs) {
      removeHooks(this.projectRoot, this.fs);
    } else {
      removeHooks(this.projectRoot);
    }
    this.installed = false;
  }

  isInstalled(): boolean {
    return this.installed;
  }
}
