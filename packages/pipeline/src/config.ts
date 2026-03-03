export interface PipelineConfig {
  llmUrl: string
  llmModel: string
  palaceId: string
}

export function defaultPipelineConfig(): Partial<PipelineConfig> {
  return {
    llmUrl:   process.env.MIDRANGE_LB_URL ?? 'http://YOUR_K8S_NODE_IP:30891/v1',
    llmModel: process.env.EXTRACTION_MODEL ?? 'qwen3.5-35b-a3b',
  }
}
