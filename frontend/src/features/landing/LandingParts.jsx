import { LayoutDashboard, LogIn, LogOut, ChevronRight } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

/**
 * Landing page pieces built with shadcn/ui. The landing page is always dark, so `.landing-ui` (index.css) pins the
 * shadcn colours to the landing palette instead of following the admin theme. Behaviour (scrolling, login, sign out,
 * the shop's catalog and FAQ) stays in pages/Landing.jsx and is passed in.
 */

export function AuthButtons({ user, pending, onAuth, onSignOut, className = '', stacked = false }) {
  return (
    <div className={`landing-ui flex ${stacked ? 'w-full flex-col' : 'items-center'} gap-3 ${className}`}>
      {user && (
        <Button variant="outline" onClick={onSignOut} className={`font-extrabold uppercase tracking-wider ${stacked ? 'w-full' : ''}`}>
          <LogOut /> Sign out
        </Button>
      )}
      <Button onClick={onAuth} className={`font-black uppercase tracking-wider ${stacked ? 'h-11 w-full' : ''}`}>
        {user ? <LayoutDashboard /> : <LogIn />}
        {pending ? 'Syncing...' : (user ? 'Dashboard' : 'Login')}
      </Button>
    </div>
  );
}

export function MobileMenu({ open, onOpenChange, links, onNavigate, user, pending, onAuth, onSignOut }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="landing-ui flex w-[min(86vw,22rem)] flex-col gap-0 border-l bg-background p-0 text-foreground">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-xs font-black uppercase tracking-widest text-muted-foreground">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Jump to a section of the page</SheetDescription>
        </SheetHeader>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {links.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={() => onNavigate(link.id)}
              className="flex min-h-12 items-center justify-between rounded-md px-3 text-left text-sm font-extrabold uppercase tracking-wider hover:bg-accent"
            >
              {link.label}
              <ChevronRight className="size-4 opacity-40" />
            </button>
          ))}
        </nav>
        <div className="border-t p-4">
          <AuthButtons user={user} pending={pending} onAuth={onAuth} onSignOut={onSignOut} stacked />
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ServiceCard({ service, formatPrice }) {
  return (
    <Card className="landing-ui lp-card-hover h-full gap-0 py-0">
      <CardContent className="flex flex-col p-6">
        <h4 className="mb-2 text-base font-black uppercase">{service.name}</h4>
        <p className="m-0 text-sm leading-relaxed text-muted-foreground">{service.desc}</p>
        <Accordion type="single" collapsible className="mt-4">
          <AccordionItem value="prices" className="border-b-0 border-t">
            <AccordionTrigger className="py-3 text-xs font-black uppercase tracking-wider text-primary hover:no-underline">
              Vehicle pricing
            </AccordionTrigger>
            <AccordionContent>
              <ul className="m-0 grid list-none gap-0 p-0">
                {Object.entries(service.prices).map(([type, price]) => (
                  <li key={type} className="flex items-center justify-between border-b py-2 last:border-b-0">
                    <span className="text-xs font-bold uppercase text-muted-foreground">{type}</span>
                    <span className="text-sm font-black">₱{formatPrice(price)}</span>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

export function FaqList({ faqs }) {
  return (
    <Accordion type="single" collapsible className="landing-ui grid gap-3">
      {faqs.map((faq, i) => (
        <AccordionItem key={i} value={`faq-${i}`} className="lp-card-hover rounded-lg border bg-card px-5 last:border-b">
          <AccordionTrigger className="text-sm font-extrabold hover:no-underline">{faq.question}</AccordionTrigger>
          {faq.answer && <AccordionContent className="leading-relaxed text-muted-foreground">{faq.answer}</AccordionContent>}
        </AccordionItem>
      ))}
    </Accordion>
  );
}

export function ContactCards({ items }) {
  return (
    <div className="landing-ui grid gap-4">
      {items.map((item, i) => (
        <Card key={i} className="gap-0 py-0">
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-background">
              <item.icon className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-[0.68rem] font-black uppercase tracking-wider text-muted-foreground">{item.label}</div>
              <div className="mt-0.5 text-sm font-extrabold [overflow-wrap:anywhere]">{item.val}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ContactForm() {
  return (
    <Card className="landing-ui gap-0 py-0">
      <CardContent className="p-6 sm:p-10">
        <form className="grid gap-5" onSubmit={(e) => e.preventDefault()}>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="contact-name" className="text-xs font-black uppercase tracking-wider text-muted-foreground">Name</Label>
              <Input id="contact-name" type="text" className="h-11 bg-background" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contact-email" className="text-xs font-black uppercase tracking-wider text-muted-foreground">Email</Label>
              <Input id="contact-email" type="email" className="h-11 bg-background" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contact-message" className="text-xs font-black uppercase tracking-wider text-muted-foreground">Message</Label>
            <textarea
              id="contact-message"
              rows={5}
              className="min-h-28 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm font-semibold text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <Button type="submit" size="lg" className="h-12 font-black uppercase tracking-wider">Send message</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function HeroBadge() {
  return (
    <div className="landing-ui mb-5 flex justify-center">
      <Badge variant="outline" className="border-primary/50 bg-primary/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-primary">
        Premium auto detailing
      </Badge>
    </div>
  );
}

export function HeroActions({ user, pending, onAuth }) {
  return (
    <div className="landing-ui flex justify-center">
      <Button onClick={onAuth} size="lg" className="h-14 px-12 text-sm font-black uppercase tracking-widest">
        {pending ? 'Syncing...' : (user ? 'Dashboard' : 'Book now')}
      </Button>
    </div>
  );
}

export function AboutFeatures({ items }) {
  return (
    <div className="landing-ui grid grid-cols-2 gap-4">
      {items.map((item) => (
        <Card key={item.title} className="lp-card-hover gap-3 py-6">
          <CardHeader className="gap-3 px-5">
            <div className="flex size-11 items-center justify-center rounded-lg bg-primary/12 ring-1 ring-primary/25">
              <item.icon className="size-6 text-primary" />
            </div>
            <CardTitle className="text-sm font-black uppercase tracking-wide">{item.title}</CardTitle>
            <CardDescription className="text-xs">{item.desc}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function SiteFooter({ businessName, links, onNavigate, socials }) {
  return (
    <footer className="landing-ui border-t border-border bg-background px-6 py-12 text-foreground">
      <div className="mx-auto grid max-w-6xl gap-8">
        <div className="flex flex-wrap items-start justify-between gap-8">
          <div>
            <div className="text-xl font-black uppercase italic tracking-tight text-primary">{businessName}</div>
            <p className="mt-2 max-w-xs text-xs text-muted-foreground">Book online, follow your job, and get an official receipt for every payment.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-1">
            {links.map((link) => (
              <Button key={link.id} variant="ghost" size="sm" onClick={() => onNavigate(link.id)} className="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground">
                {link.label}
              </Button>
            ))}
          </nav>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="m-0 text-[0.7rem] uppercase text-muted-foreground">© {new Date().getFullYear()} {businessName}. All rights reserved.</p>
          <div className="flex gap-1">
            {socials.map(({ label, icon: Icon }) => (
              <Button key={label} variant="ghost" size="icon" aria-label={label} className="text-muted-foreground hover:text-foreground">
                <Icon />
              </Button>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
