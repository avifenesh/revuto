/**
 * Model refusals.
 *
 * Claude models can decline a request through a safety classifier. The API
 * answers 200 with `stop_reason: "refusal"` (Converse: `stopReason` "refusal"
 * or "content_filtered"), and `stop_details.category` names the classifier
 * ("cyber", "bio", "reasoning_extraction", ...). A refusal is not an outage, so
 * callers retry it on the next configured model instead of failing the run.
 * `reasoning_extraction` is the exception: the prompt itself asked for hidden
 * reasoning, so another model would hit the same wall.
 */
export class ModelRefusalError extends Error {
  readonly category: string;
  readonly model: string;

  constructor(model: string, category: string | undefined, detail?: string) {
    const cat = category?.trim() || 'unknown';
    super(`model ${model} refused the request (category=${cat})${detail ? `: ${detail}` : ''}`);
    this.name = 'ModelRefusalError';
    this.category = cat;
    this.model = model;
  }
}

export function isModelRefusal(err: unknown): err is ModelRefusalError {
  return err instanceof ModelRefusalError;
}

/** True when the refusal may be retried on another model. */
export function refusalAllowsFallback(err: ModelRefusalError): boolean {
  return err.category !== 'reasoning_extraction';
}
