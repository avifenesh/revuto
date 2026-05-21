/** The three scheduled job kinds. */
export type Job = 'review' | 'learn' | 'decay';

export const isJob = (s: string): s is Job => s === 'review' || s === 'learn' || s === 'decay';
