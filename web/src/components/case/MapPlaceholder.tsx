/**
 * The Incident Location card with no coordinates to draw.
 *
 * A card that collapses to a paragraph of text loses the weight the map gives
 * the column, so the rectangle is filled with a hand-drawn street grid
 * instead. It is deliberately not a map of anywhere: no pin, no labels, no
 * real geometry, desaturated and softened so a second look reads it as the
 * placeholder it is. The caption says outright that we have not located the
 * incident, and the caller's own words still sit below the card.
 */

const CAPTION = {
  pending: "Locating this address",
  unresolved: "Location not resolved",
} as const;

/** Street centre lines. Wide ones are arterials, narrow ones are the rest. */
const AVENUES = [26, 74, 118, 168, 214, 262, 306];
const CROSS_STREETS = [22, 58, 96, 132, 168];

/**
 * Building footprints, as [x, y, width, height]. Hand-placed rather than
 * generated: a regular fill reads as a texture swatch, an irregular one reads
 * as a town. None of it corresponds to anywhere.
 */
const FOOTPRINTS: [number, number, number, number][] = [
  [33, 29, 14, 9],
  [50, 29, 17, 12],
  [33, 42, 9, 8],
  [81, 27, 12, 14],
  [96, 30, 15, 8],
  [81, 45, 30, 6],
  [125, 28, 20, 10],
  [149, 28, 12, 18],
  [125, 42, 11, 9],
  [176, 29, 16, 7],
  [176, 40, 9, 11],
  [196, 27, 12, 12],
  [221, 30, 21, 9],
  [221, 43, 13, 8],
  [244, 28, 11, 15],
  [269, 30, 17, 11],
  [292, 27, 12, 8],
  [33, 65, 18, 12],
  [56, 65, 11, 8],
  [33, 80, 12, 9],
  [81, 66, 23, 8],
  [81, 78, 13, 11],
  [125, 64, 12, 13],
  [141, 64, 19, 8],
  [176, 66, 15, 9],
  [176, 79, 22, 7],
  [201, 65, 8, 14],
  [221, 67, 19, 10],
  [244, 64, 12, 9],
  [269, 66, 14, 13],
  [289, 68, 15, 8],
  [33, 103, 13, 10],
  [51, 103, 16, 7],
  [81, 102, 11, 12],
  [96, 104, 18, 8],
  [125, 101, 22, 9],
  [125, 114, 10, 10],
  [176, 103, 9, 12],
  [190, 102, 19, 8],
  [221, 104, 14, 9],
  [239, 101, 12, 14],
  [269, 103, 20, 8],
  [292, 105, 11, 12],
  [33, 141, 19, 11],
  [56, 141, 10, 14],
  [81, 140, 14, 9],
  [99, 143, 12, 12],
  [176, 141, 11, 10],
  [191, 140, 17, 8],
  [221, 142, 12, 11],
  [238, 141, 21, 8],
  [269, 140, 13, 12],
  [288, 143, 16, 9],
];

export function MapPlaceholder({ pending }: { pending: boolean }) {
  return (
    <div className="relative h-full w-full bg-inset">
      <svg
        viewBox="0 0 320 190"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
        aria-hidden
        focusable="false"
      >
        <defs>
          {/* Softening the whole plate is what keeps it from reading as a
              rendered map: the edges stay a shade too gentle to be tiles. */}
          <filter id="map-placeholder-soften" x="-6%" y="-6%" width="112%" height="112%">
            <feGaussianBlur stdDeviation="0.4" />
          </filter>
        </defs>

        {/* The land the streets are cut out of. */}
        <rect width="320" height="190" fill="#e3e6ec" />

        <g filter="url(#map-placeholder-soften)">
          {/* Two open blocks, barely tinted, so the plate is not all grid. */}
          <rect x="140" y="98" width="30" height="36" rx="2" fill="#d8e2d7" />
          <rect x="60" y="118" width="52" height="18" rx="2" fill="#d8e2d7" />

          {/* Footprints sit under the streets, so a stray one is trimmed by
              the road rather than straddling it. */}
          <g fill="#d7dbe3">
            {FOOTPRINTS.map(([x, y, width, height]) => (
              <rect key={`${x}-${y}`} x={x} y={y} width={width} height={height} rx="1" />
            ))}
          </g>

          <g fill="none" stroke="#f6f7f9" strokeLinecap="square">
            {/* The grid: avenues down, cross streets across. */}
            {AVENUES.map((x) => (
              <path key={`avenue-${x}`} d={`M${x} -6V196`} strokeWidth="6" />
            ))}
            {CROSS_STREETS.map((y) => (
              <path key={`cross-${y}`} d={`M-6 ${y}H326`} strokeWidth="6" />
            ))}
            {/* Mid-block alleys, thin enough to read as a second order. */}
            <path d="M50 -6V196M192 -6V196M-6 78H326" strokeWidth="2.5" />
            {/* One arterial cutting the grid, so it is a place and not paper. */}
            <path d="M-8 184 L 96 116 L 200 116 L 328 34" strokeWidth="9" />
          </g>

          {/* The centre line an arterial carries on a printed map. */}
          <path
            d="M-8 184 L 96 116 L 200 116 L 328 34"
            fill="none"
            stroke="#dfe3e9"
            strokeWidth="0.9"
            strokeDasharray="4 6"
          />
        </g>

        {/* A last wash of the page colour: the plate sits a step behind the
            card rather than competing with it. */}
        <rect width="320" height="190" fill="#f4f5f7" opacity="0.18" />
      </svg>

      <div className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full border border-hairline bg-sheet/90 px-3 py-1 text-[11.5px] leading-4 font-medium text-slate-500">
          {pending ? CAPTION.pending : CAPTION.unresolved}
        </span>
      </div>
    </div>
  );
}
