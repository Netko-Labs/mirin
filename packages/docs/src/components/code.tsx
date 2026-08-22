import { SAMPLES, type SampleName } from "@/generated/samples";

/**
 * A pre-highlighted code sample.
 *
 * Highlighting happens in `scripts/highlight-samples.ts`, so Shiki never
 * reaches the client. The HTML is generated from our own source, not user
 * input.
 */
export function Code({ sample }: { sample: SampleName }) {
  return (
    <div
      className="overflow-x-auto px-5 py-4 text-[13px] leading-[1.9] [&_pre]:!bg-transparent [&_pre]:m-0"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time output of our own samples
      dangerouslySetInnerHTML={{ __html: SAMPLES[sample] }}
    />
  );
}
