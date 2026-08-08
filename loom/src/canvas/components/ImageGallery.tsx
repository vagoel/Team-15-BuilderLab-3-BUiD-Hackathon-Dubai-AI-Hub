import { useState } from "react";
import type { Dataset } from "../../contract/dataset.js";
import type { UiComponentSpec } from "../../contract/ui.js";

type ImageGallerySpec = Extract<UiComponentSpec, { type: "image_gallery" }>;

const DEFAULT_MAX = 12;

/**
 * Images scraped from the sources, each attributed to the page it came from.
 *
 * Two rules earn their keep here. Every tile names its source, because an
 * unattributable picture in a research report is worth less than no picture. And a
 * tile whose URL fails to load removes itself — scraped image URLs go stale, are
 * hotlink-protected, or point at tracking pixels, and a grid of broken-image glyphs
 * reads as a broken app rather than as a stale asset.
 */
export function ImageGallery({ spec, dataset }: { spec: ImageGallerySpec; dataset: Dataset | undefined }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  const images = (dataset?.images ?? []).filter((img) => !broken.has(img.src)).slice(0, spec.max ?? DEFAULT_MAX);

  if (!dataset?.images?.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No images were collected for this report.</p>;
  }
  if (!images.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>None of the collected images could be loaded.</p>;
  }

  const sourceTitle = (sourceId: string) =>
    dataset.sources.find((s) => s.id === sourceId)?.title ?? "unknown source";

  return (
    <div className="gallery">
      {images.map((image) => (
        <figure className="gallery-item" key={image.src}>
          <img
            src={image.src}
            alt={image.alt ?? ""}
            loading="lazy"
            onError={() => setBroken((prev) => new Set(prev).add(image.src))}
          />
          <figcaption title={sourceTitle(image.sourceId)}>{image.alt || sourceTitle(image.sourceId)}</figcaption>
        </figure>
      ))}
    </div>
  );
}
