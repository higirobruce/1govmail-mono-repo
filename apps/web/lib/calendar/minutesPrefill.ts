import { TEMPLATES } from '@/lib/docs/templates';

export interface MinutesPrefillEvent {
  title: string;
  startAt: string;
  location?: string | null;
  organizer?: string | null;
  attendees?: string[];
}

/**
 * Build the minutes document for a meeting from the Meeting Minutes template,
 * with the event's own facts in place of the template's placeholders.
 *
 * The template lives in the web app next to the editor that renders it, so the
 * API never has to know about TipTap — it stores what it is given.
 */
export function minutesPrefill(event: MinutesPrefillEvent): { title: string; content: string } {
  const template = TEMPLATES.find((t) => t.id === 'minutes');
  if (!template) throw new Error('The Meeting Minutes template is missing');

  const when = new Date(event.startAt).toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short',
  });
  const attendees = (event.attendees ?? []).filter((a) => a && a.trim().length > 0);

  // Replace the template's bracketed placeholders with what the event knows.
  // Anything the event cannot answer keeps its placeholder, so the person
  // writing the minutes can see what still needs filling in.
  //
  // `[Name]` is deliberately NOT in this list — it appears three times in the
  // template (Chairperson, Minutes Recorder, and the sample action item's
  // Owner), and a global replace would fill all three with the organizer.
  // Only the Chairperson slot is something the event actually knows; it is
  // patched by position below, after JSON.parse.
  const replacements: Array<[string, string]> = [
    ['[Title of Meeting]', event.title],
    ['[Date and Time]', when],
    ['[Venue or Video Conference Link]', event.location?.trim() || 'Not recorded'],
  ];

  let json = JSON.stringify(template.content);
  for (const [from, to] of replacements) {
    json = json.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }

  const doc = JSON.parse(json);

  // `[Name]` appears three times in the template — Chairperson, Minutes Recorder
  // and the sample action item's Owner. Only the first is something the event
  // knows, so patch it by position rather than replacing the string everywhere.
  const chair = event.organizer?.trim();
  if (chair) {
    const para = doc.content?.find(
      (n: any) =>
        n.type === 'paragraph' && n.content?.[0]?.text?.startsWith('Chairperson:'),
    );
    const slot = para?.content?.[1];
    if (slot?.type === 'text') slot.text = chair;
  }

  // The attendee bullet list is the one place the template's two sample
  // bullets are replaced wholesale rather than patched.
  if (attendees.length) {
    const list = doc.content?.find(
      (n: any) => n.type === 'bulletList',
    );
    if (list) {
      list.content = attendees.map((email) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: email }] }],
      }));
    }
  }

  return { title: `Minutes — ${event.title}`, content: JSON.stringify(doc) };
}
