import { useEffect, useMemo, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Crosshair, Eye, Image as ImageIcon, ImagePlus, Camera, LayoutGrid, Loader2, MapPin, PencilLine, Plus, RotateCcw, Save, Search, Trash2, Type, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AboutFeatures } from '@/features/landing/LandingParts';
import {
  ABOUT_ICONS, aboutIcon, DEFAULT_ABOUT_BODY, DEFAULT_ABOUT_CARDS, DEFAULT_ABOUT_HEADING,
  MAX_ABOUT_CARDS, MAX_BODY, MAX_CARD_TEXT, MAX_CARD_TITLE, MAX_HEADING, resolveAbout,
} from '@/features/site-content/aboutContent';
import { useConfig } from '@/context/ConfigContext';
import { fetchShopConfig } from '@/config/shopConfig';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { useConfirmAction } from '@/hooks/useConfirmAction';
import AboutGallery, { ABOUT_LAYOUTS } from '@/features/site-content/AboutGallery';
import ShopMap from '@/features/site-content/ShopMap';
import { TourLauncher } from '@/components/common/GuidedTour';
import { ADMIN_TOURS } from '@/features/tours/adminTours';

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

const noTags = (value) => String(value || '').replace(/[<>]/g, '');
let cardSeq = 0;
const withKeys = (cards) => cards.map((c) => ({ ...c, key: `c${cardSeq++}` }));

const toDraft = (settings) => {
  const about = resolveAbout(settings);
  return {
  hero: settings.HERO_PHOTO ? { ...settings.HERO_PHOTO } : null,
  heading: about.heading,
  body: about.body,
  cards: withKeys(about.cards),
  photos: (settings.ABOUT_PHOTOS || []).map((p) => ({ id: p.id, url: p.url, caption: p.caption || '' })),
  layout: settings.ABOUT_LAYOUT || 'mosaic',
  location: settings.SHOP_LOCATION ? { ...settings.SHOP_LOCATION } : null,
  };
};
const keyOf = (draft) => JSON.stringify({
  hero: draft.hero?.id || null,
  heading: draft.heading.trim(),
  body: draft.body.trim(),
  cards: draft.cards.map((c) => [c.icon, c.title.trim(), c.text.trim()]),
  photos: draft.photos.map((p) => [p.id, p.caption.trim()]),
  layout: draft.layout,
  location: draft.location ? [draft.location.lat.toFixed(6), draft.location.lng.toFixed(6), draft.location.zoom, (draft.location.label || '').trim()] : null,
});

// which draft fields belong to each collapsible section (each one saves on its own)
const SECTIONS = { hero: ['hero'], text: ['heading', 'body'], cards: ['cards'], photos: ['photos', 'layout'], map: ['location'] };
const SECTION_LABELS = { hero: 'Top banner photo', text: 'About text', cards: 'About highlights', photos: 'About photos and layout', map: 'Map pin' };
const sectionKey = (draft, id) => {
  const k = JSON.parse(keyOf(draft));
  if (id === 'hero') return JSON.stringify(k.hero);
  if (id === 'text') return JSON.stringify([k.heading, k.body]);
  if (id === 'cards') return JSON.stringify(k.cards);
  if (id === 'photos') return JSON.stringify([k.photos, k.layout]);
  return JSON.stringify(k.location);
};

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
  const heroFileRef = useRef(null);
  const [heroUploading, setHeroUploading] = useState(false);

  const saved = useMemo(() => toDraft(settings), [settings]);
  const savedKey = keyOf(saved);
  const dirty = Object.fromEntries(Object.keys(SECTIONS).map((id) => [id, sectionKey(draft, id) !== sectionKey(saved, id)]));
  const [open, setOpen] = useState({});
  const [previewSection, setPreviewSection] = useState(null);
  const [savingSection, setSavingSection] = useState(null);

  // follow another administrator's save, one section at a time: sections nobody is editing here take the new values
  const prevSaved = useRef(saved);
  useEffect(() => {
    const before = prevSaved.current;
    prevSaved.current = saved;
    setDraft((d) => {
      const next = { ...d };
      for (const [id, fields] of Object.entries(SECTIONS)) {
        if (sectionKey(d, id) === sectionKey(before, id)) fields.forEach((f) => { next[f] = saved[f]; });
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const setPhotos = (fn) => setDraft((d) => ({ ...d, photos: fn(d.photos) }));
  const room = MAX_PHOTOS - draft.photos.length;

  const sendPhoto = async (file) => {
    const form = new FormData();
    form.append('photo', file);
    const headers = await authHeaders();
    delete headers['Content-Type']; // the browser sets the multipart boundary
    const response = await fetch(`${BACKEND_URL}/api/admin/site-photos`, { method: 'POST', headers, body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) throw new Error(body.error || 'The photo could not be uploaded.');
    return body.photo;
  };
  const photoProblem = (file) => {
    if (!ACCEPT.split(',').includes(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return `${file.name} is not a JPEG, PNG, WebP or HEIC photo.`;
    if (file.size > MAX_UPLOAD_BYTES) return `${file.name} is larger than 8 MB.`;
    return '';
  };

  const uploadHero = async (file) => {
    if (!file) return;
    const problem = photoProblem(file);
    if (problem) { toast.error(problem); return; }
    setHeroUploading(true);
    try {
      const photo = await sendPhoto(file);
      setDraft((d) => ({ ...d, hero: { id: photo.id, url: photo.url } }));
    } catch (error) {
      toast.error(error.message || 'The photo could not be uploaded.');
    } finally {
      setHeroUploading(false);
    }
  };

  const setCards = (fn) => setDraft((d) => ({ ...d, cards: fn(d.cards) }));
  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, Math.max(0, room));
    if (!files.length) { if (room <= 0) toast.error(`You can show up to ${MAX_PHOTOS} photos. Remove one first.`); return; }
    for (const file of files) {
      const problem = photoProblem(file);
      if (problem) { toast.error(problem); continue; }
      setUploading((n) => n + 1);
      try {
        const photo = await sendPhoto(file);
        setPhotos((list) => (list.length >= MAX_PHOTOS ? list : [...list, photo]));
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

  // Each section saves on its own: the request carries this section's edits and the saved values of every other one.
  const saveSection = async (id) => {
    const src = { ...saved };
    SECTIONS[id].forEach((f) => { src[f] = draft[f]; });
    if (!src.location) { toast.error('Pin the shop on the map and save it first.'); return; }
    setSaving(true);
    setSavingSection(id);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/site-content`, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({
          photos: src.photos.map((p) => ({ id: p.id, caption: p.caption })),
          layout: src.layout,
          location: { lat: src.location.lat, lng: src.location.lng, zoom: src.location.zoom, label: src.location.label },
          heroPhotoId: src.hero?.id || null,
          about: {
            heading: src.heading.trim() === DEFAULT_ABOUT_HEADING ? '' : src.heading,
            body: src.body.trim() === DEFAULT_ABOUT_BODY ? '' : src.body,
            cards: src.cards.map((c) => ({ icon: c.icon, title: c.title, text: c.text })),
          },
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error || 'The changes could not be saved.');
      await fetchShopConfig({ force: true });
      if (body.textsSaved === false && ['hero', 'text', 'cards'].includes(id)) {
        toast.warning('This part needs a database update first, so it was not saved yet.');
      } else {
        toast.success('Section saved. The landing page shows it now.', { icon: <Save size={18} /> });
      }
    } catch (error) {
      toast.error(error.message || 'The changes could not be saved.');
    } finally {
      setSaving(false);
      setSavingSection(null);
    }
  };
  const discardSection = (id) => setDraft((d) => {
    const next = { ...d };
    SECTIONS[id].forEach((f) => { next[f] = saved[f]; });
    return next;
  });

  const busy = saving || uploading > 0 || heroUploading;
  const untitledCard = draft.cards.some((c) => !c.title.trim());
  const noSavedPin = !saved.location;
  // why Save is off for a section, if it is
  const blockReason = (id) => {
    if (id === 'map') return draft.location ? '' : 'Pin the shop on the map before saving.';
    if (id === 'cards' && untitledCard) return 'Every highlight needs a title.';
    if (noSavedPin) return 'Save the map pin first. The landing page always shows where the shop is.';
    return '';
  };

  const sectionProps = (id) => ({
    id,
    open: Boolean(open[id]),
    onToggle: () => setOpen((o) => ({ ...o, [id]: !o[id] })),
    dirty: dirty[id],
    busy,
    saving: savingSection === id,
    blockReason: blockReason(id),
    onPreview: () => setPreviewSection(id),
    onDiscard: () => discardSection(id),
    onSave: () => confirmThen({ title: 'Save this section?', message: 'The landing page will show this part straight away. Other sections keep what was saved before.', confirmText: 'Save' }, () => saveSection(id)),
  });

  return (
    <div className="ui-root grid gap-3" data-tour="about-sections">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
          <TourLauncher steps={ADMIN_TOURS.about} label="How About & Map works" />
          Open a section to edit it. Each section has its own preview and save.
        </p>
      </div>

      <Section {...sectionProps('hero')} icon={ImageIcon} title="Top banner photo"
        description="The large photo behind the headline at the top of the landing page.">
        <p className="m-0 text-sm text-muted-foreground">A wide photo of your shop or a freshly cleaned car works best. It is darkened so the text stays easy to read. With no photo, the banner is plain dark.</p>

          <div className="relative grid aspect-[16/7] max-h-64 place-items-center overflow-hidden rounded-[2px] bg-[#0A0B0D] text-white">
            {draft.hero && <img src={draft.hero.url} alt="Top banner" className="absolute inset-0 size-full object-cover" />}
            <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/45 to-black/75" aria-hidden="true" />
            <span className="relative px-4 text-center text-sm font-black uppercase tracking-wide sm:text-lg">
              {draft.hero ? 'Your headline sits here' : 'No banner photo: plain dark background'}
            </span>
          </div>
          <input ref={heroFileRef} type="file" accept={ACCEPT} hidden onChange={(e) => { uploadHero(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => heroFileRef.current?.click()} disabled={busy} className="flex-1 sm:flex-none">
              {heroUploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} {heroUploading ? 'Uploading…' : draft.hero ? 'Replace photo' : 'Upload photo'}
            </Button>
            {draft.hero && (
              <Button type="button" variant="outline" className="flex-1 text-destructive sm:flex-none" disabled={busy} onClick={() => setDraft((d) => ({ ...d, hero: null }))}>
                <Trash2 /> Remove photo
              </Button>
            )}
          </div>
      </Section>

      <Section {...sectionProps('text')} icon={Type} title="About text"
        description="The heading and paragraph in the About section.">
        <p className="m-0 text-sm text-muted-foreground">Press Enter twice to start a new paragraph.</p>

          <div className="grid gap-1.5">
            <Label htmlFor="about-heading">Heading</Label>
            <Input id="about-heading" maxLength={MAX_HEADING} value={draft.heading} placeholder={DEFAULT_ABOUT_HEADING}
              onChange={(e) => { const value = noTags(e.target.value); setDraft((d) => ({ ...d, heading: value })); }} />
            <span className="text-right text-[11px] text-muted-foreground">{draft.heading.length}/{MAX_HEADING}</span>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="about-body">Paragraph</Label>
            <Textarea id="about-body" rows={6} maxLength={MAX_BODY} value={draft.body} placeholder={DEFAULT_ABOUT_BODY}
              onChange={(e) => { const value = noTags(e.target.value); setDraft((d) => ({ ...d, body: value })); }} />
            <span className="text-right text-[11px] text-muted-foreground">{draft.body.length}/{MAX_BODY}</span>
          </div>
          <div>
            <Button type="button" variant="outline" className="w-full sm:w-auto"
              disabled={draft.heading === DEFAULT_ABOUT_HEADING && draft.body === DEFAULT_ABOUT_BODY}
              onClick={() => setDraft((d) => ({ ...d, heading: DEFAULT_ABOUT_HEADING, body: DEFAULT_ABOUT_BODY }))}>
              <RotateCcw /> Use the standard text
            </Button>
          </div>
      </Section>

      <Section {...sectionProps('cards')} icon={LayoutGrid} title="About highlights"
        description={`${draft.cards.length} of ${MAX_ABOUT_CARDS} small cards next to the About text.`}>
        <p className="m-0 text-sm text-muted-foreground">Each card has an icon, a short title and one line. With none, the text uses the full width.</p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{`${draft.cards.length} of ${MAX_ABOUT_CARDS} highlights`}</span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="flex-1 sm:flex-none"
                onClick={() => setCards(() => withKeys(DEFAULT_ABOUT_CARDS))}>
                <RotateCcw /> Use the standard highlights
              </Button>
              <Button type="button" className="flex-1 sm:flex-none" disabled={draft.cards.length >= MAX_ABOUT_CARDS}
                onClick={() => setCards((list) => [...list, ...withKeys([{ icon: 'sparkles', title: '', text: '' }])])}>
                <Plus /> Add highlight
              </Button>
            </div>
          </div>
          {draft.cards.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No highlights. The About text uses the full width.</div>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
              {draft.cards.map((card, i) => (
                <li key={card.key} className="grid gap-3 rounded-md border p-3">
                  <fieldset className="m-0 grid gap-1.5 border-0 p-0">
                    <legend className="mb-1.5 text-sm font-medium">{`Icon for highlight ${i + 1}`}</legend>
                    <div role="radiogroup" aria-label={`Icon for highlight ${i + 1}`} className="grid w-fit grid-cols-4 gap-1.5 sm:grid-cols-6">
                      {ABOUT_ICONS.map(({ key, label, Icon }) => {
                        const active = card.icon === key;
                        return (
                          <button key={key} type="button" role="radio" aria-checked={active} aria-label={label} title={label}
                            onClick={() => setCards((list) => list.map((c) => (c.key === card.key ? { ...c, icon: key } : c)))}
                            className={`grid size-11 shrink-0 place-items-center rounded-[2px] border transition-colors ${active ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30' : 'text-muted-foreground hover:border-foreground/30 hover:text-foreground'}`}>
                            <Icon className="size-4" />
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  <div className="grid gap-1">
                    <Label htmlFor={`card-title-${card.key}`} className="text-xs">Title</Label>
                    <Input id={`card-title-${card.key}`} maxLength={MAX_CARD_TITLE} value={card.title} placeholder="e.g. Protection"
                      aria-invalid={!card.title.trim()}
                      onChange={(e) => { const value = noTags(e.target.value); setCards((list) => list.map((c) => (c.key === card.key ? { ...c, title: value } : c))); }} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`card-text-${card.key}`} className="text-xs">Line (optional)</Label>
                    <Input id={`card-text-${card.key}`} maxLength={MAX_CARD_TEXT} value={card.text} placeholder="e.g. Premium ceramic coatings"
                      onChange={(e) => { const value = noTags(e.target.value); setCards((list) => list.map((c) => (c.key === card.key ? { ...c, text: value } : c))); }} />
                    <span className="text-right text-[11px] text-muted-foreground">{card.text.length}/{MAX_CARD_TEXT}</span>
                  </div>
                  <div className="flex justify-end">
                    <Button type="button" variant="outline" className="text-destructive" onClick={() => setCards((list) => list.filter((c) => c.key !== card.key))}>
                      <Trash2 /> Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

      </Section>

      <Section {...sectionProps('photos')} icon={Camera} title="About photos and layout"
        description={`${draft.photos.length} of ${MAX_PHOTOS} photos, shown under the About text.`}>
        <p className="m-0 text-sm text-muted-foreground">Each photo can have a caption. Photos are resized and cleaned of hidden data (like GPS) when uploaded.</p>

          <div className="flex flex-wrap items-center justify-between gap-3" data-tour="about-add">
            <span className="text-sm text-muted-foreground">{draft.photos.length} of {MAX_PHOTOS} photos</span>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
            <Button type="button" onClick={() => fileRef.current?.click()} disabled={busy || room <= 0} className="w-full sm:w-auto">
              {uploading > 0 ? <Loader2 className="animate-spin" /> : <ImagePlus />} {uploading > 0 ? 'Uploading…' : 'Add photo'}
            </Button>
          </div>

          {draft.photos.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" data-tour="about-photos">
              No photos yet. Add some to show your shop in the About section.
            </div>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3" data-tour="about-photos">
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
        <div className="grid gap-2">
          <h4 className="m-0 text-sm font-semibold">Photo layout</h4>

          <div role="radiogroup" aria-label="Photo layout" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-tour="about-layout">
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
        </div>
      </Section>

      <Section {...sectionProps('map')} icon={MapPin} title="Map pin"
        description={draft.location ? 'Required. Shown under About us so customers can find the shop.' : 'Required. No pin yet.'}>

          <form onSubmit={searchAddress} className="grid gap-1.5" role="search" data-tour="about-search">
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
          <div data-tour="about-map">
          <ShopMap
            editable
            location={draft.location}
            height={360}
            onChange={(at) => setDraft((d) => ({ ...d, location: { ...at, label: d.location?.label || '' } }))}
          />
          </div>
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
      </Section>

      <Dialog open={Boolean(previewSection)} onOpenChange={(next) => { if (!next) setPreviewSection(null); }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto border-0 bg-[#0A0B0D] p-0 text-white sm:max-w-5xl">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-white">{previewSection ? SECTION_LABELS[previewSection] : 'Preview'}</DialogTitle>
            <DialogDescription className="text-white/60">Preview: this is how this part of the landing page will look after you save. Nothing is saved yet.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 px-5 pb-6">
            {previewSection === 'hero' && <HeroPreview hero={draft.hero} />}
            {(previewSection === 'text' || previewSection === 'cards') && (
              <AboutPreviewBody heading={draft.heading} body={draft.body} cards={draft.cards} photos={[]} layout={draft.layout} location={null} hideEmptyPhotos />
            )}
            {previewSection === 'photos' && (draft.photos.length ? <AboutGallery photos={draft.photos} layout={draft.layout} /> : <p className="m-0 text-sm text-white/60">No photos. The About section shows no gallery.</p>)}
            {previewSection === 'map' && (draft.location ? (
              <div className="grid gap-2">
                <h3 className="m-0 text-sm font-black uppercase tracking-wider text-white/80">Find us</h3>
                <ShopMap location={draft.location} height={300} />
                {draft.location.label && <p className="m-0 text-sm text-white/70">{draft.location.label}</p>}
              </div>
            ) : <p className="m-0 text-sm text-white/60">No pin yet.</p>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One collapsible part of the About & Map tab, with its own preview, discard and save. */
function Section({ id, icon: Icon, title, description, open, onToggle, dirty, busy, saving, blockReason, onPreview, onDiscard, onSave, children }) {
  const panelId = `about-section-${id}`;
  return (
    <Card className="gap-0 py-0" data-tour={`about-sec-${id}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-4 text-left sm:px-6"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[2px] bg-primary/10 text-primary"><Icon className="size-4" /></span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {title}
            {dirty && <span className="inline-flex items-center gap-1 rounded-[2px] bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300"><PencilLine className="size-3" />Unsaved changes</span>}
          </span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
        {open ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div id={panelId} className="grid gap-4 border-t px-4 pb-4 pt-4 sm:px-6">
          {children}
          <div className="grid gap-2 border-t pt-4">
            {blockReason && dirty && <p className="m-0 text-sm text-destructive" role="alert">{blockReason}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onPreview} className="flex-1 sm:flex-none"><Eye /> See preview</Button>
              <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={onDiscard} className="flex-1 sm:flex-none"><Undo2 /> Discard</Button>
              <Button type="button" disabled={!dirty || busy || Boolean(blockReason)} onClick={onSave} className="w-full sm:w-auto">
                {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function HeroPreview({ hero }) {
  return (
    <div className="relative grid min-h-48 place-items-center overflow-hidden rounded-[2px] bg-[#0A0B0D] p-6 text-center">
      {hero && <img src={hero.url} alt="" className="absolute inset-0 size-full object-cover" />}
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/45 to-black/75" aria-hidden="true" />
      <p className="relative m-0 text-xl font-black uppercase leading-tight sm:text-3xl">
        Turn the color <br /><span className="text-[#C41F2B]">to the maximum</span>
      </p>
    </div>
  );
}

/** The part of the landing page's About section this card controls (also used by the preview). */
export function AboutPreviewBody({ heading, body, cards = [], photos, layout, location, hideEmptyPhotos = false }) {
  const items = cards.filter((c) => c.title.trim()).map((c) => ({ icon: aboutIcon(c.icon), title: c.title.trim(), desc: c.text.trim() }));
  return (
    <>
      <div className={`grid items-center gap-6 ${items.length ? 'md:grid-cols-2' : ''}`}>
        <div className="grid gap-3">
          <h2 className="m-0 text-2xl font-black uppercase">{heading.trim() || DEFAULT_ABOUT_HEADING}</h2>
          {(body.trim() || DEFAULT_ABOUT_BODY).split(/\n{2,}/).map((para, i) => (
            <p key={i} className="m-0 whitespace-pre-line text-sm leading-relaxed text-white/65">{para}</p>
          ))}
        </div>
        {items.length > 0 && <AboutFeatures items={items} />}
      </div>
      {photos.length ? <AboutGallery photos={photos} layout={layout} /> : !hideEmptyPhotos && <p className="m-0 text-sm text-white/60">No photos yet.</p>}
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
