"use client";

/**
 * Where the incident is, and a map of it.
 *
 * The map is an OpenStreetMap embed: an iframe with a bounding box and a
 * marker. No key, no account, no map library. Everything else on the card is
 * conditional on how much the geocoder actually resolved - the panel has three
 * honest states (a pin, "still locating", "no match") and never dresses one up
 * as another.
 */

import type { CaseGeo } from "@/lib/geo";
import { addressLines, mapsLink, osmEmbedUrl } from "@/lib/geo";
import { Icon } from "./icons";
import { Absent, Card, Pill } from "./ui";

function searchLink(query: string): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

export function IncidentLocation({ geo, flashing = false }: { geo: CaseGeo; flashing?: boolean }) {
  const address = addressLines(geo.formatted);
  const target = geo.hasPoint ? mapsLink(geo.latitude as number, geo.longitude as number) : null;
  const fallbackTarget = geo.formatted ? searchLink(geo.formatted) : null;
  const link = target ?? fallbackTarget;

  return (
    <Card
      title="Incident Location"
      action={
        geo.precision === "approximate" ? (
          <Pill tone="amber">
            <Icon name="alert" className="h-3.5 w-3.5" />
            Approximate location
          </Pill>
        ) : null
      }
      bodyClassName="px-5 pt-2 pb-4"
    >
      <div className={`-mx-1.5 rounded-lg px-1.5 py-1 ${flashing ? "flash" : ""}`}>
        {address ? (
          <>
            <p className="text-[14px] leading-5 font-medium text-slate-900">{address.street}</p>
            {address.region ? <p className="text-[13px] leading-5 text-slate-500">{address.region}</p> : null}
          </>
        ) : (
          <p className="text-[13.5px] leading-5">
            <Absent>No location captured yet</Absent>
          </p>
        )}
      </div>

      <div className="mt-3 h-[190px] overflow-hidden rounded-xl border border-slate-200">
        {geo.hasPoint ? (
          // The embed prints its own credit line across the bottom of the map,
          // which wraps to two lines at this width and covers the pin's street.
          // The iframe is drawn taller than its frame so that strip is clipped,
          // and the required OpenStreetMap credit is rendered below instead.
          <iframe
            title="Map of the incident location"
            // `loading="lazy"` keeps the tile fetch off the critical path; the
            // card renders its address instantly either way.
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="block h-[232px] w-full border-0 bg-slate-100"
            src={osmEmbedUrl(geo.latitude as number, geo.longitude as number, geo.precision)}
          />
        ) : (
          <div className="flex h-[190px] flex-col items-center justify-center gap-2 bg-slate-50 px-4 text-center">
            <Icon name="map" className="h-6 w-6 text-slate-300" />
            <p className="text-[12.5px] leading-4 text-slate-500">
              {geo.pending ? "Locating this address" : "No map pin for this address yet"}
            </p>
            {/* `unresolved` is the same value whether the geocoder is still out
                or came back with nothing, so this line has to be true of both. */}
            <p className="max-w-[230px] text-[11.5px] leading-4 text-slate-400">
              {geo.pending
                ? "The pin appears here as soon as the address resolves."
                : "The caller's words are all the city has so far. A pin appears here if the address resolves."}
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700"
          >
            Open in Maps
            <Icon name="external" className="h-3.5 w-3.5" />
          </a>
        ) : (
          <span className="text-[12.5px] text-slate-400">No address to open</span>
        )}
        {geo.hasPoint ? (
          <span className="font-mono text-[11.5px] text-slate-400 tabular-nums">
            {(geo.latitude as number).toFixed(5)}, {(geo.longitude as number).toFixed(5)}
          </span>
        ) : null}
      </div>

      {geo.hasPoint ? (
        <p className="mt-1.5 text-[11px] leading-4 text-slate-400">
          Map data{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-slate-300 underline-offset-2 hover:text-slate-600"
          >
            &copy; OpenStreetMap contributors
          </a>
        </p>
      ) : null}

      {geo.detail ? (
        <p className="mt-3 flex gap-2 border-t border-slate-100 pt-3 text-[12.5px] leading-5 text-slate-600">
          <Icon name="crosshair" className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>{geo.detail}</span>
        </p>
      ) : null}
    </Card>
  );
}
