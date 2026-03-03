// @locigram/registry — connector plugin registry + loader
import type { ConnectorPlugin, Connector } from '@locigram/core'

export interface ConnectorConfig {
  plugin: string          // package name or local path
  config: unknown         // passed to plugin.create()
  enabled?: boolean
}

class ConnectorRegistry {
  private plugins = new Map<string, ConnectorPlugin>()

  register(plugin: ConnectorPlugin): void {
    this.plugins.set(plugin.name, plugin)
    console.log(`[registry] registered connector: ${plugin.name}@${plugin.version}`)
  }

  load(configs: ConnectorConfig[]): Connector[] {
    return configs
      .filter(c => c.enabled !== false)
      .map(c => {
        const plugin = this.plugins.get(c.plugin)
        if (!plugin) throw new Error(`[registry] unknown connector plugin: ${c.plugin}`)

        // Validate config against plugin's schema
        const parsed = plugin.configSchema.parse(c.config)

        const connector = plugin.create(parsed)
        console.log(`[registry] loaded connector: ${c.plugin}`)
        return connector
      })
  }

  list(): string[] {
    return [...this.plugins.keys()]
  }
}

export const registry = new ConnectorRegistry()
export type { ConnectorPlugin, Connector }
