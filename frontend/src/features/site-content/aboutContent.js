import { Award, BadgeCheck, Car, Clock, Droplets, Heart, Shield, Sparkles, Star, ThumbsUp, Wrench, Zap } from 'lucide-react';

/**
 * The landing page's About text and highlight cards (Business Hub › About & Map). The icon keys match the list the
 * database accepts (validate_site_content) and the backend checks (ABOUT_ICONS); keep the three in step.
 */
export const ABOUT_ICONS = [
  { key: 'shield', label: 'Shield', Icon: Shield },
  { key: 'zap', label: 'Lightning', Icon: Zap },
  { key: 'star', label: 'Star', Icon: Star },
  { key: 'clock', label: 'Clock', Icon: Clock },
  { key: 'sparkles', label: 'Sparkles', Icon: Sparkles },
  { key: 'droplets', label: 'Water drops', Icon: Droplets },
  { key: 'car', label: 'Car', Icon: Car },
  { key: 'wrench', label: 'Wrench', Icon: Wrench },
  { key: 'award', label: 'Award', Icon: Award },
  { key: 'thumbs-up', label: 'Thumbs up', Icon: ThumbsUp },
  { key: 'badge-check', label: 'Check badge', Icon: BadgeCheck },
  { key: 'heart', label: 'Heart', Icon: Heart },
];
export const aboutIcon = (key) => (ABOUT_ICONS.find((i) => i.key === key) || ABOUT_ICONS[0]).Icon;

export const MAX_ABOUT_CARDS = 4;
export const MAX_HEADING = 80;
export const MAX_BODY = 1200;
export const MAX_CARD_TITLE = 40;
export const MAX_CARD_TEXT = 100;

export const DEFAULT_ABOUT_HEADING = 'About us';
export const DEFAULT_ABOUT_BODY = "At Comar Garage, we believe that every vehicle deserves to look its absolute best. Founded with a passion for automotive excellence, we have grown into one of the region's most trusted detailing centers.";
export const DEFAULT_ABOUT_CARDS = [
  { icon: 'shield', title: 'Protection', text: 'Premium ceramic coatings' },
  { icon: 'zap', title: 'Performance', text: 'Expert technicians' },
  { icon: 'star', title: 'Quality', text: 'Satisfaction guaranteed' },
  { icon: 'clock', title: 'Reliability', text: 'Punctual service' },
];

/** What the landing page shows: saved values, or the standard ones when nothing was saved yet. */
export const resolveAbout = (settings) => ({
  heading: String(settings?.ABOUT_HEADING || '').trim() || DEFAULT_ABOUT_HEADING,
  body: String(settings?.ABOUT_BODY || '').trim() || DEFAULT_ABOUT_BODY,
  cards: Array.isArray(settings?.ABOUT_CARDS) ? settings.ABOUT_CARDS : DEFAULT_ABOUT_CARDS,
});
