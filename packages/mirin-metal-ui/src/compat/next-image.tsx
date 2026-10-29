/** `next/image` on Metal: an `<img>` (remote images are cached locally). */

export interface ImageProps {
  src: string | { src: string };
  alt?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  className?: string;
  [prop: string]: unknown;
}

export default function Image({ src, fill, ...props }: ImageProps) {
  const url = typeof src === "string" ? src : src.src;
  return <img src={url} {...props} {...(fill ? { "data-fill": true } : {})} />;
}
