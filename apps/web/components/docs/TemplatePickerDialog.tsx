'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface Template {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  content: object;
}

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank Page',
    description: 'Start with an empty page',
    emoji: '📄',
    category: 'Basic',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  },
  {
    id: 'memo',
    name: 'Memorandum',
    description: 'Official government memo with standard header',
    emoji: '📋',
    category: 'Official Documents',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'MEMORANDUM' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'TO:\u00a0' }, { type: 'text', text: '[Recipient Name, Title, Department]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'FROM:\u00a0' }, { type: 'text', text: '[Sender Name, Title, Department]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'DATE:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'SUBJECT:\u00a0' }, { type: 'text', text: '[Subject of the Memorandum]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '1. Purpose' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[State the purpose of this memorandum]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '2. Background' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Provide relevant background information and context]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '3. Discussion' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Main body of the memorandum with details, findings, or analysis]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '4. Recommendations / Action Required' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[State the recommended course of action and who is responsible]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '5. Conclusion' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Summarise key points and next steps]' }] },
      ],
    },
  },
  {
    id: 'minutes',
    name: 'Meeting Minutes',
    description: 'Attendees, agenda, decisions, action items',
    emoji: '📝',
    category: 'Official Documents',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Meeting Minutes' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Meeting Title:\u00a0' }, { type: 'text', text: '[Title of Meeting]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Date & Time:\u00a0' }, { type: 'text', text: '[Date and Time]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Location / Platform:\u00a0' }, { type: 'text', text: '[Venue or Video Conference Link]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Chairperson:\u00a0' }, { type: 'text', text: '[Name]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Minutes Recorder:\u00a0' }, { type: 'text', text: '[Name]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Attendees' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name, Title, Department]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name, Title, Department]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Apologies' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Names of those who sent apologies]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Agenda' }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Agenda Item 1]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Agenda Item 2]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Any Other Business' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Discussion & Decisions' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Agenda Item 1: [Topic]' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Discussion notes, decisions made, rationale]' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Agenda Item 2: [Topic]' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Discussion notes, decisions made, rationale]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Action Items' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Action' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Owner' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Due Date' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Action description]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Date]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pending' }] }] }] },
          ],
        },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Next Meeting' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Date, Time, Location]' }] },
      ],
    },
  },
  {
    id: 'sop',
    name: 'Standard Operating Procedure',
    description: 'Purpose, scope, procedure steps, revision history',
    emoji: '📚',
    category: 'Official Documents',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Standard Operating Procedure (SOP)' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'SOP Number:\u00a0' }, { type: 'text', text: '[SOP-XXX-000]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Version:\u00a0' }, { type: 'text', text: '1.0' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Effective Date:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Review Date:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Approved By:\u00a0' }, { type: 'text', text: '[Name, Title]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Department:\u00a0' }, { type: 'text', text: '[Department Name]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '1. Purpose' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Describe the purpose and objective of this SOP]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '2. Scope' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Define what is covered by this procedure and who it applies to]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '3. Definitions' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '[Term]: ' }, { type: 'text', text: '[Definition]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '4. Responsibilities' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '[Role]: ' }, { type: 'text', text: '[Responsibility description]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '5. Procedure' }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Step 1: Detailed description of the action]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Step 2: Detailed description of the action]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Step 3: Detailed description of the action]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '6. References' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Referenced legislation, regulation, or document]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '7. Revision History' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Version' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Date' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Author' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changes' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1.0' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Date]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial version' }] }] }] },
          ],
        },
      ],
    },
  },
  {
    id: 'policy-brief',
    name: 'Policy Brief',
    description: 'Problem, options, recommendations, implementation',
    emoji: '🏛️',
    category: 'Policy & Strategy',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Policy Brief' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Issue:\u00a0' }, { type: 'text', text: '[Policy Issue Title]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Prepared by:\u00a0' }, { type: 'text', text: '[Name, Department]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Date:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Executive Summary' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[2–3 sentence summary of the issue, proposed solution, and expected impact]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Background' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Provide context, historical background, and current state of the issue]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Problem Statement' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Clearly define the problem, including supporting data and evidence]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Policy Options' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Option 1: [Name]' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Description, advantages, disadvantages, cost and resource implications]' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Option 2: [Name]' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Description, advantages, disadvantages, cost and resource implications]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Preferred Recommendation' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Recommended course of action with clear justification and risk assessment]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Implementation Plan' }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Implementation step 1]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Implementation step 2]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Monitoring & Evaluation' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[KPIs, review timelines, and success criteria]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'References' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Citations, legislation, and supporting documents]' }] },
      ],
    },
  },
  {
    id: 'incident',
    name: 'Incident Report',
    description: 'Incident details, impact, response, lessons learned',
    emoji: '🚨',
    category: 'Reports',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Incident Report' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Report Number:\u00a0' }, { type: 'text', text: '[INC-YYYY-000]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Date of Incident:\u00a0' }, { type: 'text', text: '[Date and Time]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Date of Report:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Reported By:\u00a0' }, { type: 'text', text: '[Name, Title, Department]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Severity:\u00a0' }, { type: 'text', text: '[Critical / High / Medium / Low]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '1. Incident Description' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Provide a clear, factual description of what occurred, where, and how]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '2. Impact Assessment' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Systems affected: ' }, { type: 'text', text: '[List affected systems or services]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Users affected: ' }, { type: 'text', text: '[Number and description]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Duration: ' }, { type: 'text', text: '[Start time to resolution time]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Data breach: ' }, { type: 'text', text: '[Yes / No — if yes, describe]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '3. Root Cause Analysis' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Describe the root cause of the incident]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '4. Response Actions Taken' }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Action taken and by whom]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Containment measures]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Recovery steps]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '5. Lessons Learned' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Key lessons and how they will improve future response]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '6. Corrective Actions' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Action' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Owner' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Target Date' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Corrective action]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Date]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open' }] }] }] },
          ],
        },
      ],
    },
  },
  {
    id: 'project-charter',
    name: 'Project Charter',
    description: 'Objectives, stakeholders, deliverables, milestones',
    emoji: '🗂️',
    category: 'Reports',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Project Charter' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Project Name:\u00a0' }, { type: 'text', text: '[Project Name]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Project Manager:\u00a0' }, { type: 'text', text: '[Name, Title]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Sponsor:\u00a0' }, { type: 'text', text: '[Executive Sponsor Name, Title]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Start Date:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Target Completion:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '1. Project Overview' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Brief description of the project and its strategic alignment]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '2. Objectives' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Specific, measurable objective 1]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Specific, measurable objective 2]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '3. Scope' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'In Scope' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[In-scope item]' }] }] }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Out of Scope' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Out-of-scope item]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '4. Stakeholders' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Role' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Department' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Responsibility' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Name]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Role]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Department]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Responsibility]' }] }] }] },
          ],
        },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '5. Key Deliverables' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Deliverable 1]' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Deliverable 2]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '6. Milestones' }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Milestone' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Target Date' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Milestone name]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Date]' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Planned' }] }] }] },
          ],
        },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '7. Risks & Assumptions' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Key risks, assumptions, constraints, and dependencies]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '8. Budget' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Approved budget and funding source]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '9. Approval' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Approved by: ____________________________  Date: ____________' }] },
      ],
    },
  },
  {
    id: 'weekly-report',
    name: 'Weekly Status Report',
    description: 'Progress, blockers, upcoming tasks for weekly reporting',
    emoji: '📊',
    category: 'Reports',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Weekly Status Report' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Week Ending:\u00a0' }, { type: 'text', text: '[Date]' }] },
        { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Prepared by:\u00a0' }, { type: 'text', text: '[Name, Department]' }] },
        { type: 'horizontalRule' },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Summary' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Brief overall summary of the week]' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Completed This Week' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Completed task or milestone]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'In Progress' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Ongoing task — % complete, expected completion]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Planned for Next Week' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Planned task]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Issues & Blockers' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[Issue description and impact — action/support needed]' }] }] }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Key Metrics' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '[Relevant KPIs or performance metrics for the week]' }] },
      ],
    },
  },
];

const CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];

interface TemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: { title: string; emoji: string; content: string }) => void;
}

export function TemplatePickerDialog({ open, onOpenChange, onSelect }: TemplatePickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>New page</DialogTitle>
          <p className="text-sm text-muted-foreground mt-0.5">Choose a template to get started quickly</p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {CATEGORIES.map((category) => (
            <div key={category} className="mb-6">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{category}</p>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.filter((t) => t.category === category).map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-lg border border-border text-left',
                      'hover:bg-muted/60 hover:border-primary/40 transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                    onClick={() => {
                      onSelect({
                        title: template.id === 'blank' ? 'Untitled' : template.name,
                        emoji: template.emoji,
                        content: JSON.stringify(template.content),
                      });
                      onOpenChange(false);
                    }}
                  >
                    <span className="text-2xl shrink-0 mt-0.5">{template.emoji}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-tight">{template.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{template.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
