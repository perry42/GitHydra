// SPDX-License-Identifier: GPL-3.0-or-later
import "./BannerIcon.css";
import { IconCheck, IconError, IconInfo, IconWarning } from "../Icon/Icon";

export type BannerTone = "info" | "success" | "warning" | "error";

/** specs/banner-uniform-look.md FR-646: the one leading glyph per status, aria-hidden (the banner text carries the meaning); colour comes from the banner's own tone class. */
export function BannerIcon({ tone }: { tone: BannerTone }) {
  const Glyph = tone === "success" ? IconCheck : tone === "warning" ? IconWarning : tone === "error" ? IconError : IconInfo;
  return (
    <span className="gh-banner-icon" aria-hidden="true">
      <Glyph size={14} />
    </span>
  );
}
