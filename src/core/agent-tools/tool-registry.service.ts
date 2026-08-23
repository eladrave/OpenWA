import { Injectable } from '@nestjs/common';
import type { AnyToolDescriptor } from './tool-descriptor';

@Injectable()
export class ToolRegistryService {
  private readonly byName = new Map<string, AnyToolDescriptor>();

  constructor(tools: AnyToolDescriptor[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) {
        throw new Error(`Duplicate agent tool name: ${t.name}`);
      }
      this.byName.set(t.name, t);
    }
  }

  list(
    opts: {
      readOnly?: boolean;
      profile?: 'all' | 'monitoring';
      allowMonitorConfigWrites?: boolean;
      allowEnrollmentWrites?: boolean;
    } = {},
  ): AnyToolDescriptor[] {
    const all = [...this.byName.values()].filter(
      tool => (opts.profile ?? 'all') !== 'monitoring' || tool.surface === 'monitoring',
    );
    return all.filter(tool => {
      if (tool.tier === 'read') return true;
      if (tool.writeCapability === 'monitor-config') return opts.allowMonitorConfigWrites === true;
      if (tool.writeCapability === 'enrollment') return opts.allowEnrollmentWrites === true;
      return opts.readOnly !== true;
    });
  }

  get(name: string): AnyToolDescriptor | undefined {
    return this.byName.get(name);
  }
}
