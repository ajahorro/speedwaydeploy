import { useEffect, useMemo, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { ArrowDown, ArrowUp, Crosshair, Eye, ImagePlus, Loader2, MapPin, Save, Search, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfig } from '@/context/ConfigContext';
import { fetchShopConfig } from '@/config/shopConfig';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { useConfirmAction } from '@/hooks/useConfirmAction';
import AboutGallery, { ABOUT_LAYOUTS } from '@/features/site-content/AboutGallery';
import ShopMap from '@/features/site-content/ShopMap';

/**
 * Business Hub › About & Map. Photos (with captions) and their layout for the landing page's About section, and the
 * shop's map pin shown under it. Nothing reaches the site until Save; "See preview" shows the unsaved version exactly
 * as the landing page will draw it.
 *
 * Uploads go to the backend, which checks the administrator, re-encodes the photo and stores it under its own name;
 * Save sends only ids, captions, the layout and the pin, and the backend rebuilds every URL itself. The database
 * refuses these fields from the browser, so this card cannot be bypassed by editing requests.
 */
const MAX_PHOTOS = 12;
const MAX_CAPTION = 140;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

const toDraft = (settings) => ({
  photos: (settings.ABOUT_PHOTOS || []).map((p) => ({ id: p.id, url: p.url, caption: p.caption || '' })),
  layout: settings.ABOUT_LAYOUT || 'mosaic',
  location: settings.SHOP_LOCATION ? { ...settings.SHOP_LOCATION } : null,
});
const keyOf = (draft) => JSON.stringify({
  photos: draft.photos.map((p) => [p.id, p.caption.trim()]),
  layout: draft.layout,
  location: draft.location ? [draft.location.lat.toFixed(6), draft.location.lng.toFixed(6), draft.location.zoom, (draft.location.label || '').trim()] : null,
});

function LayoutSketch({ id }) {
  // tiny diagrams of each layout, drawn with boxes so they follow the theme
  const box = 'rounded-[2px] bg-muted-foreground/25';
  const line = 'h-1 rounded-full bg-muted-foreground/40';
  if (id === 'carousel') {
    return (
      <div className="grid h-16 grid-rows-[1fr_auto] gap-1">
        <div className={`${box} relative`}><span className="absolute left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" /><span className="absolute right-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" /></div>
        <div className="flex items-center justify-between gap-2"><span className={`${line} w-2/3`} /><span className="flex gap-0.5"><i className="size-1 rounded-full bg-primary" /><i className="size-1 rounded-full bg-muted-foreground/40" /></span></div>
      </div>
    );
  }
  if (id === 'grid') {
    return (
      <div className="grid h-16 grid-cols-3 gap-1">
        {[0, 1, 2].map((i) => <div key={i} className="grid grid-rows-[1fr_auto] gap-0.5"><div className={box} /><span className={line} /></div>)}
      </div>
    );
  }
  if (id === 'split') {
    return (
      <div className="grid h-16 gap-1">
        <div className="grid grid-cols-2 items-center gap-1"><div className={`${box} h-7`} /><span className={line} /></div>
        <div className="grid grid-cols-2 items-center gap-1"><span className={line} /><div className={`${box} h-7`} /></div>
      </div>
    );
  }
  return (
    <div className="grid h-16 grid-cols-4 grid-rows-2 gap-1">
      <div className={`${box} relative col-span-2 row-span-2`}><span className="absolute inset-x-1 bottom-1 h-1 rounded-full bg-background/80" /></div>
      {[0, 1, 2, 3].map((i) => <div key={i} className={box} />)}
    </div>
  );
}

export function AboutMapCard() {
  const { settings } = useConfig();
  const { confirmThen } = useConfirmAction();
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  // address search -> pin
  const [addressQuery, setAddressQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState(null); // null = no search yet

  const searchAddress = async (event) => {
    event?.preventDefault();
    const q = addressQuery.trim();
    if (q.length < 3) { toast.error('Type at least 3 characters of the address.'); return; }
    setSearching(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/geocode?q=${encodeURIComponent(q)}`, { headers: await authHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || 'The address search did not work.');
      setMatches(body.results || []);
      // one clear match: drop the pin straight away
      if ((body.results || []).length === 1) pickMatch(body.results[0]);
    } catch (error) {
      toast.error(error.message || 'The address search did not work.');
      setMatches(null);
    } finally {
      setSearching(false);
    }
  };

  const pickMatch = (match) => {
    const shortLabel = String(match.label || '').split(',').slice(0, 3).join(',').trim();
    setDraft((d) => ({ ...d, location: { lat: match.lat, lng: match.lng, zoom: 17, label: d.location?.label || shortLabel } }));
    setMatches(null);
  };
  const fileRef = useRef(null);

  const saved = useMemo(() => toDraft(settings), [settings]);
  const savedKey = keyOf(saved);
  const isDirty = keyOf(draft) !== savedKey;

  // follow another administrator's save while nothing here is being edited
  const [baseline, setBaseline] = useState(savedKey);
  useEffect(() => {
    if (savedKey !== baseline) {
      if (!isDirty || keyOf(draft) === baseline) setDraft(saved);
      setBaseline(savedKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const setPhotos = (fn) => setDraft((d) => ({ ...d, photos: fn(d.photos) }));
  const room = MAX_PHOTOS - draft.photos.length;

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, Math.max(0, room));
    if (!files.length) { if (room <= 0) toast.error(`You can show up to ${MAX_PHOTOS} photos. Remove one first.`); return; }
    for (const file of files) {
      if (!ACCEPT.split(',').includes(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) { toast.error(`${file.name} is not a JPEG, PNG, WebP or HEIC photo.`); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { toast.error(`${file.name} is larger than 8 MB.`); continue; }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('photo', file);
        const headers = await authHeaders();
        delete headers['Content-Type']; // the browser sets the multipart boundary
        const response = await fetch(`${BACKEND_URL}/api/admin/site-photos`, { method: 'POST', headers, body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.success) throw new Error(body.error || 'The photo could not be uploaded.');
        setPhotos((list) => (list.length >= MAX_PHOTOS ? list : [...list, body.photo]));
      } catch (error) {
        toast.error(error.message || 'The photo could not be uploaded.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const move = (index, step) => setPhotos((list) => {
    const next = [...list];
    const to = index + step;
    if (to < 0 || to >= next.length) return list;
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error('This browser cannot share its location.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); setDraft((d) => ({ ...d, location: { lat: pos.coords.latitude, lng: pos.coords.longitude, zoom: 17, label: d.location?.label || '' } })); },
      () => { setLocating(false); toast.error('Your location could not be read. Click the map instead.'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/site-content`, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({
          photos: draft.photos.map((p) => ({ id: p.id, caption: p.caption })),
          layout: draft.layout,
          location: draft.location ? { lat: draft.location.lat, lng: draft.location.lng, zoom: draft.location.zoom, label: draft.location.label } : null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || 'The changes could not be saved.');
      await fetchShopConfig({ force: true });
      toast.success('About photos and map saved. The landing page shows them now.', { icon: <Save size={18} /> });
    } catch (error) {
      toast.error(error.message || 'The changes could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || uploading > 0;

  return (
    <div className="ui-root grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>About photos</CardTitle>
          <CardDescription>
            Shown in the About section of the landing page. Up to {MAX_PHOTOS} photos, each with an optional caption. Photos are
            resized and cleaned of hidden data (like GPS) when uploaded.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{draft.photos.length} of {MAX_PHOTOS} photos</span>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
            <Button type="button" onClick={() => fileRef.current?.click()} disabled={busy || room <= 0} className="w-full sm:w-auto">
              {uploading > 0 ? <Loader2 className="animate-spin" /> : <ImagePlus />} {uploading > 0 ? 'Uploading…' : 'Add photo'}
            </Button>
          </div>

          {draft.photos.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No photos yet. Add some to show your shop in the About section.
            </div>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {draft.photos.map((photo, i) => (
                <li key={photo.id} className="grid gap-2 rounded-md border p-2">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-[2px] bg-muted">
                    <img src={photo.url} alt={photo.caption || `Photo ${i + 1}`} className="size-full object-cover" loading="lazy" />
                    <span className="absolute left-1.5 top-1.5 rounded-[2px] bg-background/85 px-1.5 py-0.5 text-xs font-semibold">{i + 1}</span>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`cap-${photo.id}`} className="text-xs">Caption (optional)</Label>
                    <Input
                      id={`cap-${photo.id}`}
                      value={photo.caption}
                      maxLength={MAX_CAPTION}
                      placeholder="e.g. Our detailing bay"
                      onChange={(e) => { const value = e.target.value.replace(/[<>]/g, ''); setPhotos((list) => list.map((p) => (p.id === photo.id ? { ...p, caption: value } : p))); }}
                    />
                    <span className="text-right text-[11px] text-muted-foreground">{photo.caption.length}/{MAX_CAPTION}</span>
                  </div>
                  <div className="flex gap-1.5">
                    <Button type="button" size="icon" variant="outline" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move earlier"><ArrowUp /></Button>
                    <Button type="button" size="icon" variant="outline" disabled={i === draft.photos.length - 1} onClick={() => move(i, 1)} aria-label="Move later"><ArrowDown /></Button>
                    <Button type="button" variant="outline" className="ml-auto text-destructive" onClick={() => setPhotos((list) => list.filter((p) => p.id !== photo.id))}>
                      <Trash2 /> Remove photo
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Photo layout</CardTitle>
          <CardDescription>How the photos and captions are arranged on the landing page.</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Photo layout" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {ABOUT_LAYOUTS.map((layout) => {
              const active = draft.layout === layout.id;
              return (
                <button
                  key={layout.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setDraft((d) => ({ ...d, layout: layout.id }))}
                  className={`grid gap-2 rounded-md border p-3 text-left transition-colors ${active ? 'border-primary ring-2 ring-primary/30' : 'hover:border-foreground/30'}`}
                >
                  <LayoutSketch id={layout.id} />
                  <span className="text-sm font-semibold">{layout.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{layout.hint}</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Map pin</CardTitle>
          <CardDescription>Search the shop's address, or click the map, then drag the pin to the exact spot. The landing page shows this map under About us.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <form onSubmit={searchAddress} className="grid gap-1.5" role="search">
            <Label htmlFor="pin-search">Find the shop by address</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="pin-search"
                type="search"
                autoComplete="off"
                maxLength={200}
                placeholder="e.g. Ortigas Ave Extension, Cainta, Rizal"
                value={addressQuery}
                onChange={(e) => setAddressQuery(e.target.value)}
              />
              <Button type="submit" disabled={searching} className="sm:w-auto">
                {searching ? <Loader2 className="animate-spin" /> : <Search />} Search
              </Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">Pick the right match, then drag the pin if it needs to be more exact.</p>
          </form>

          {matches && (
            matches.length === 0 ? (
              <p className="m-0 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No place found for that address. Try fewer words (street and city), or click the map instead.
              </p>
            ) : matches.length > 1 && (
              <ul className="m-0 grid list-none gap-1 p-0" aria-label="Address matches">
                {matches.map((match) => (
                  <li key={`${match.lat},${match.lng}`}>
                    <button
                      type="button"
                      onClick={() => pickMatch(match)}
                      className="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm hover:border-primary"
                    >
                      <MapPin className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{match.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={useMyLocation} disabled={locating} className="flex-1 sm:flex-none">
              {locating ? <Loader2 className="animate-spin" /> : <Crosshair />} Use my current location
            </Button>
            {draft.location && (
              <Button type="button" variant="outline" className="flex-1 text-destructive sm:flex-none" onClick={() => setDraft((d) => ({ ...d, location: null }))}>
                <Trash2 /> Remove pin
              </Button>
            )}
          </div>
          <ShopMap
            editable
            location={draft.location}
            height={360}
            onChange={(at) => setDraft((d) => ({ ...d, location: { ...at, label: d.location?.label || '' } }))}
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="pin-label">Name on the pin (optional)</Label>
              <Input
                id="pin-label"
                maxLength={120}
                placeholder="e.g. Comar Garage, Cainta"
                value={draft.location?.label || ''}
                disabled={!draft.location}
                onChange={(e) => { const value = e.target.value.replace(/[<>]/g, ''); setDraft((d) => (d.location ? { ...d, location: { ...d.location, label: value } } : d)); }}
              />
            </div>
            <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="size-3.5" />
              {draft.location ? `${draft.location.lat.toFixed(5)}, ${draft.location.lng.toFixed(5)}` : 'No pin yet'}
            </p>
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)} className="flex-1 sm:flex-none"><Eye /> See preview</Button>
          <Button type="button" variant="ghost" disabled={!isDirty || busy} onClick={() => setDraft(saved)} className="flex-1 sm:flex-none"><Undo2 /> Discard</Button>
          <Button
            type="button"
            disabled={!isDirty || busy}
            className="w-full sm:w-auto"
            onClick={() => confirmThen({ title: 'Save About photos and map?', message: 'The landing page will show these photos, captions, layout and map pin straight away.', confirmText: 'Save' }, save)}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto border-0 bg-[#0A0B0D] p-0 text-white sm:max-w-5xl">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-white">Preview: About section</DialogTitle>
            <DialogDescription className="text-white/60">This is how the landing page will look after you save. Nothing is saved yet.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 px-5 pb-6">
            <AboutPreviewBody photos={draft.photos} layout={draft.layout} location={draft.location} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The part of the landing page's About section this card controls (also used by the preview). */
export function AboutPreviewBody({ photos, layout, location }) {
  return (
    <>
      <h2 className="m-0 text-2xl font-black uppercase">About us</h2>
      {photos.length ? <AboutGallery photos={photos} layout={layout} /> : <p className="m-0 text-sm text-white/60">No photos yet.</p>}
      {location && (
        <div className="grid gap-2">
          <h3 className="m-0 text-sm font-black uppercase tracking-wider text-white/80">Find us</h3>
          <ShopMap location={location} height={280} />
          {location.label && <p className="m-0 text-sm text-white/70">{location.label}</p>}
        </div>
      )}
    </>
  );
}
