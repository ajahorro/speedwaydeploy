import { Link } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Shown for any address that does not exist, instead of a blank screen or a silent jump elsewhere. */
export default function NotFound({ home = '/', label = 'Go to the home page', inLayout = false }) {
  return (
    <main className="ui-root flex items-center justify-center bg-background p-6 text-foreground" style={{ minHeight: inLayout ? '60vh' : '100%', height: inLayout ? undefined : '100%', overflowY: 'auto' }}>
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <SearchX size={44} className="text-primary" aria-hidden="true" />
        <p className="text-sm font-black uppercase tracking-widest text-muted-foreground">Error 404</p>
        <h1 className="text-2xl font-black">This page doesn't exist</h1>
        <p className="text-sm text-muted-foreground">The link may be mistyped or the page may have moved.</p>
        <Button asChild className="h-11 rounded-[2px] font-black uppercase tracking-wider"><Link to={home}>{label}</Link></Button>
      </div>
    </main>
  );
}
