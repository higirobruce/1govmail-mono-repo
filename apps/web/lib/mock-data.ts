// Mock data for UI preview / development without a running API server

const now = new Date();
const ago = (mins: number) => new Date(now.getTime() - mins * 60000).toISOString();

export const MOCK_FOLDERS = [
  { id: 'f1', name: 'Inbox',   path: '/Inbox',   unreadCount: 5,  totalCount: 120, type: 'MAIL', color: null, parentId: null },
  { id: 'f2', name: 'Sent',    path: '/Sent',    unreadCount: 0,  totalCount: 43,  type: 'MAIL', color: null, parentId: null },
  { id: 'f3', name: 'Drafts',  path: '/Drafts',  unreadCount: 2,  totalCount: 3,   type: 'MAIL', color: null, parentId: null },
  { id: 'f4', name: 'Trash',   path: '/Trash',   unreadCount: 0,  totalCount: 11,  type: 'MAIL', color: null, parentId: null },
  { id: 'f5', name: 'Archive', path: '/Archive', unreadCount: 0,  totalCount: 204, type: 'MAIL', color: null, parentId: null },
  { id: 'f6', name: 'Work',    path: '/Work',    unreadCount: 3,  totalCount: 58,  type: 'MAIL', color: null, parentId: null },
];

export const MOCK_MESSAGES = [
  { id: 'm1', subject: 'Q3 Budget Review — Action Required',  snippet: 'Please review the attached spreadsheet before our 3pm call. Numbers look tighter than expected.', fromName: 'Sarah Chen',  fromEmail: 's.chen@acme.com',           isRead: false, isStarred: true,  hasAttachments: true,  tags: ['work'],    receivedAt: ago(12)   },
  { id: 'm2', subject: 'Re: Product roadmap for H2',          snippet: 'Totally agree. Let me loop in design and set up a sync early next week.',                         fromName: 'James Liu',   fromEmail: 'jliu@corp.io',              isRead: false, isStarred: false, hasAttachments: false, tags: [],           receivedAt: ago(45)   },
  { id: 'm3', subject: 'Your invoice #4821 is ready',         snippet: 'Hi Alex, your invoice for Sep 30 is now available in your billing portal.',                      fromName: 'Stripe',      fromEmail: 'billing@stripe.com',        isRead: true,  isStarred: false, hasAttachments: true,  tags: ['finance'], receivedAt: ago(90)   },
  { id: 'm4', subject: 'Welcome to Linear — get started',     snippet: 'Here are a few things to help you hit the ground running.',                                      fromName: 'Linear',      fromEmail: 'hello@linear.app',          isRead: true,  isStarred: false, hasAttachments: false, tags: [],           receivedAt: ago(180)  },
  { id: 'm5', subject: 'Re: Design review notes',             snippet: "Added comments in Figma. Main concern is contrast ratio on secondary buttons — needs AA.",        fromName: 'Maya Patel',  fromEmail: 'maya@studio.co',            isRead: false, isStarred: false, hasAttachments: false, tags: ['design'],  receivedAt: ago(240)  },
  { id: 'm6', subject: 'Deployment pipeline update',          snippet: 'Staging is back up. All green on CI. Good to push to prod after sign-off.',                      fromName: 'DevOps Bot',  fromEmail: 'ci@github.com',             isRead: true,  isStarred: false, hasAttachments: false, tags: [],           receivedAt: ago(360)  },
  { id: 'm7', subject: 'Lunch Tuesday?',                      snippet: "Are you free Tuesday? Thinking of that new ramen spot on 5th.",                                   fromName: 'Tom Wright',  fromEmail: 'tom.w@gmail.com',           isRead: true,  isStarred: true,  hasAttachments: false, tags: [],           receivedAt: ago(600)  },
  { id: 'm8', subject: 'Security alert: new sign-in',         snippet: 'A new sign-in was detected from San Francisco, CA. If this was you, no action needed.',          fromName: 'Google',      fromEmail: 'noreply@accounts.google.com', isRead: true, isStarred: false, hasAttachments: false, tags: [],           receivedAt: ago(1440) },
];

export const MOCK_MESSAGE_DETAIL = {
  ...MOCK_MESSAGES[0],
  toRecipients: [{ email: 'alex@company.com', name: 'Alex Morgan' }],
  ccRecipients: [{ email: 'team@company.com', name: 'Team' }],
  bodyHtml: `
    <p>Hi Alex,</p>
    <p>Please review the attached Q3 budget spreadsheet before our 3pm call today.
    We are currently <strong>12% under target</strong> on enterprise renewals and
    need to align on next steps before the board presentation.</p>
    <p>Key items to focus on:</p>
    <ul>
      <li>Enterprise renewal pipeline (slides 3–5)</li>
      <li>New headcount request justification (slide 8)</li>
      <li>Q4 forecast assumptions (slide 12)</li>
    </ul>
    <p>Let me know if you have questions before the call.</p>
    <p>Best,<br/>Sarah</p>
  `,
  attachments: [
    { id: 'a1', filename: 'Q3_Budget_Review.xlsx', mimeType: 'application/vnd.ms-excel', size: 245760 },
    { id: 'a2', filename: 'Renewal_Pipeline.pdf',  mimeType: 'application/pdf',          size: 1048576 },
  ],
};
