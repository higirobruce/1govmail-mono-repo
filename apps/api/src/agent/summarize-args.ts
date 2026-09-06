/** Short human-readable arg summaries for tool_start frames and proposal cards. */
export function summarizeArgs(tool: string, args: any): string {
  switch (tool) {
    case 'search_emails':
    case 'search_documents':
    case 'search_contacts':
      return `"${args.query}"`;
    case 'read_email':
    case 'get_thread':
      return String(args.messageId);
    case 'read_attachment':
      return `${args.messageId} part ${args.part}`;
    case 'read_document':
      return String(args.docId);
    case 'compare_documents':
      return `${args.docIdA} vs ${args.docIdB}`;
    case 'send_email':
    case 'draft_email':
      return `to ${(args.to ?? []).join(', ')} — "${args.subject ?? ''}"`;
    case 'create_calendar_event':
      return `"${args.title}" ${args.startAt}`;
    case 'create_task':
    case 'create_document':
    case 'create_chart':
      return `"${args.title}"`;
    case 'list_events':
    case 'get_mail_stats':
      return `${args.startDate} → ${args.endDate}`;
    case 'get_freebusy':
      return (args.emails ?? []).join(', ');
    case 'get_person':
      return String(args.email);
    case 'list_tasks':
      return args.status ?? 'all';
    default:
      return JSON.stringify(args ?? {}).slice(0, 120);
  }
}
