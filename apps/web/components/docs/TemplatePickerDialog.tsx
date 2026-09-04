'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface UserTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  content: string | null;
  createdAt: string;
}

interface Template {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  sections: string[];
  content: object;
}

const T = (text: string) => ({ type: 'text', text });
const B = (text: string) => ({ type: 'text', marks: [{ type: 'bold' }], text });
const P = (...content: object[]) => ({ type: 'paragraph', content });
const H = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [T(text)] });
const HR = () => ({ type: 'horizontalRule' });
const BL = (...items: string[]) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [P(T(t))] })) });
const OL = (...items: string[]) => ({ type: 'orderedList', content: items.map((t) => ({ type: 'listItem', content: [P(T(t))] })) });
const TH = (...cols: string[]) => ({ type: 'tableRow', content: cols.map((c) => ({ type: 'tableHeader', content: [c ? P(T(c)) : P()] })) });
const TR = (...cols: string[]) => ({ type: 'tableRow', content: cols.map((c) => ({ type: 'tableCell', content: [c ? P(T(c)) : P()] })) });
const TABLE = (...rows: object[]) => ({ type: 'table', content: rows });

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank Page',
    description: 'Start with an empty page',
    emoji: '📄',
    category: 'Basic',
    sections: [],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  },
  // ── Official Documents ──────────────────────────────────────────────────────
  {
    id: 'memo',
    name: 'Memorandum',
    description: 'Official government memo with standard header',
    emoji: '📋',
    category: 'Official Documents',
    sections: ['Purpose', 'Background', 'Discussion', 'Recommendations', 'Conclusion'],
    content: { type: 'doc', content: [
      H(2, 'MEMORANDUM'),
      P(B('TO:\u00a0'), T('[Recipient Name, Title, Department]')),
      P(B('FROM:\u00a0'), T('[Sender Name, Title, Department]')),
      P(B('DATE:\u00a0'), T('[Date]')),
      P(B('SUBJECT:\u00a0'), T('[Subject of the Memorandum]')),
      HR(),
      H(3, '1. Purpose'),
      P(T('[State the purpose of this memorandum]')),
      H(3, '2. Background'),
      P(T('[Provide relevant background information and context]')),
      H(3, '3. Discussion'),
      P(T('[Main body of the memorandum with details, findings, or analysis]')),
      H(3, '4. Recommendations / Action Required'),
      P(T('[State the recommended course of action and who is responsible]')),
      H(3, '5. Conclusion'),
      P(T('[Summarise key points and next steps]')),
    ]},
  },
  {
    id: 'briefing-note',
    name: 'Briefing Note',
    description: 'Concise brief for senior officials on a specific issue',
    emoji: '📌',
    category: 'Official Documents',
    sections: ['Purpose', 'Key Points', 'Background', 'Issues / Options', 'Recommendation', 'Next Steps', 'Contact'],
    content: { type: 'doc', content: [
      H(2, 'Briefing Note'),
      P(B('TO:\u00a0'), T('[Minister / Director General / Senior Official]')),
      P(B('FROM:\u00a0'), T('[Name, Title, Department]')),
      P(B('DATE:\u00a0'), T('[Date]')),
      P(B('SUBJECT:\u00a0'), T('[Brief descriptive title of the issue]')),
      P(B('CLASSIFICATION:\u00a0'), T('[Unclassified / Internal Use Only / Restricted / Confidential]')),
      HR(),
      H(3, 'Purpose'),
      P(T('[One sentence: what this note is about and what action or awareness is needed]')),
      H(3, 'Key Points'),
      BL('[Key point 1]', '[Key point 2]', '[Key point 3]'),
      H(3, 'Background'),
      P(T('[Concise context — no more than 3 short paragraphs. Assume the reader is well-informed but busy]')),
      H(3, 'Issues / Options'),
      H(4, 'Option A: [Name]'),
      P(T('[Summary, pros, cons]')),
      H(4, 'Option B: [Name]'),
      P(T('[Summary, pros, cons]')),
      H(3, 'Recommendation'),
      P(T('[Clear, direct recommendation and justification]')),
      H(3, 'Next Steps / Action Required'),
      OL('[Action 1 — by whom, by when]', '[Action 2 — by whom, by when]'),
      H(3, 'Contact'),
      P(T('[Name, Title, Phone, Email]')),
    ]},
  },
  {
    id: 'cabinet-paper',
    name: 'Cabinet / Board Paper',
    description: 'Ministerial submission with financial and legal implications',
    emoji: '🏦',
    category: 'Official Documents',
    sections: ['Executive Summary', 'Background', 'Proposal', 'Financial Implications', 'Legal Implications', 'Consultations', 'Risks', 'Recommendation'],
    content: { type: 'doc', content: [
      H(2, 'Cabinet / Board Paper'),
      P(B('Ministry / Organisation:\u00a0'), T('[Name]')),
      P(B('Reference:\u00a0'), T('[Ref Number]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Author:\u00a0'), T('[Name, Title]')),
      P(B('Classification:\u00a0'), T('[Restricted / Confidential]')),
      HR(),
      H(3, 'Executive Summary'),
      P(T('[Concise summary of the proposal and recommended decision — max 200 words]')),
      H(3, '1. Background'),
      P(T('[Context, history, and why this matter is before Cabinet / the Board now]')),
      H(3, '2. Proposal'),
      P(T('[Detailed description of what is being proposed and why]')),
      H(3, '3. Financial Implications'),
      P(T('[Cost estimates, funding source, impact on budget baseline, treasury implications]')),
      H(3, '4. Legal Implications'),
      P(T('[Relevant legislation, compliance requirements, legal risks, attorney-general considerations]')),
      H(3, '5. Consultations'),
      P(T('[Stakeholders and agencies consulted, their views, and how they were addressed]')),
      H(3, '6. Risks'),
      TABLE(
        TH('Risk', 'Likelihood', 'Impact', 'Mitigation'),
        TR('[Risk description]', '[High / Medium / Low]', '[High / Medium / Low]', '[Mitigation strategy]'),
      ),
      H(3, '7. Recommendation'),
      P(T('[That Cabinet / the Board AGREE to …]')),
      HR(),
      P(T('Prepared by: ____________________________  Date: ____________')),
      P(T('Approved by: ____________________________  Date: ____________')),
    ]},
  },
  {
    id: 'minutes',
    name: 'Meeting Minutes',
    description: 'Attendees, agenda, decisions, action items',
    emoji: '📝',
    category: 'Official Documents',
    sections: ['Attendees', 'Apologies', 'Agenda', 'Discussion & Decisions', 'Action Items', 'Next Meeting'],
    content: { type: 'doc', content: [
      H(2, 'Meeting Minutes'),
      P(B('Meeting Title:\u00a0'), T('[Title of Meeting]')),
      P(B('Date & Time:\u00a0'), T('[Date and Time]')),
      P(B('Location / Platform:\u00a0'), T('[Venue or Video Conference Link]')),
      P(B('Chairperson:\u00a0'), T('[Name]')),
      P(B('Minutes Recorder:\u00a0'), T('[Name]')),
      HR(),
      H(3, 'Attendees'),
      BL('[Name, Title, Department]', '[Name, Title, Department]'),
      H(3, 'Apologies'),
      P(T('[Names of those who sent apologies]')),
      H(3, 'Agenda'),
      OL('[Agenda Item 1]', '[Agenda Item 2]', 'Any Other Business'),
      H(3, 'Discussion & Decisions'),
      H(4, 'Agenda Item 1: [Topic]'),
      P(T('[Discussion notes, decisions made, rationale]')),
      H(4, 'Agenda Item 2: [Topic]'),
      P(T('[Discussion notes, decisions made, rationale]')),
      H(3, 'Action Items'),
      TABLE(
        TH('Action', 'Owner', 'Due Date', 'Status'),
        TR('[Action description]', '[Name]', '[Date]', 'Pending'),
      ),
      H(3, 'Next Meeting'),
      P(T('[Date, Time, Location]')),
    ]},
  },
  {
    id: 'sop',
    name: 'Standard Operating Procedure',
    description: 'Purpose, scope, procedure steps, revision history',
    emoji: '📚',
    category: 'Official Documents',
    sections: ['Purpose', 'Scope', 'Definitions', 'Responsibilities', 'Procedure', 'References', 'Revision History'],
    content: { type: 'doc', content: [
      H(2, 'Standard Operating Procedure (SOP)'),
      P(B('SOP Number:\u00a0'), T('[SOP-XXX-000]')),
      P(B('Version:\u00a0'), T('1.0')),
      P(B('Effective Date:\u00a0'), T('[Date]')),
      P(B('Review Date:\u00a0'), T('[Date]')),
      P(B('Approved By:\u00a0'), T('[Name, Title]')),
      P(B('Department:\u00a0'), T('[Department Name]')),
      HR(),
      H(3, '1. Purpose'),
      P(T('[Describe the purpose and objective of this SOP]')),
      H(3, '2. Scope'),
      P(T('[Define what is covered by this procedure and who it applies to]')),
      H(3, '3. Definitions'),
      BL('[Term]: [Definition]'),
      H(3, '4. Responsibilities'),
      BL('[Role]: [Responsibility description]'),
      H(3, '5. Procedure'),
      OL('[Step 1: Detailed description of the action]', '[Step 2: Detailed description of the action]', '[Step 3: Detailed description of the action]'),
      H(3, '6. References'),
      BL('[Referenced legislation, regulation, or document]'),
      H(3, '7. Revision History'),
      TABLE(
        TH('Version', 'Date', 'Author', 'Changes'),
        TR('1.0', '[Date]', '[Name]', 'Initial version'),
      ),
    ]},
  },

  // ── Policy & Strategy ───────────────────────────────────────────────────────
  {
    id: 'policy-brief',
    name: 'Policy Brief',
    description: 'Problem, options, recommendations, implementation',
    emoji: '🏛️',
    category: 'Policy & Strategy',
    sections: ['Executive Summary', 'Background', 'Problem Statement', 'Policy Options', 'Recommendation', 'Implementation', 'Monitoring & Evaluation'],
    content: { type: 'doc', content: [
      H(2, 'Policy Brief'),
      P(B('Issue:\u00a0'), T('[Policy Issue Title]')),
      P(B('Prepared by:\u00a0'), T('[Name, Department]')),
      P(B('Date:\u00a0'), T('[Date]')),
      HR(),
      H(3, 'Executive Summary'),
      P(T('[2–3 sentence summary of the issue, proposed solution, and expected impact]')),
      H(3, 'Background'),
      P(T('[Provide context, historical background, and current state of the issue]')),
      H(3, 'Problem Statement'),
      P(T('[Clearly define the problem, including supporting data and evidence]')),
      H(3, 'Policy Options'),
      H(4, 'Option 1: [Name]'),
      P(T('[Description, advantages, disadvantages, cost and resource implications]')),
      H(4, 'Option 2: [Name]'),
      P(T('[Description, advantages, disadvantages, cost and resource implications]')),
      H(3, 'Preferred Recommendation'),
      P(T('[Recommended course of action with clear justification and risk assessment]')),
      H(3, 'Implementation Plan'),
      OL('[Implementation step 1]', '[Implementation step 2]'),
      H(3, 'Monitoring & Evaluation'),
      P(T('[KPIs, review timelines, and success criteria]')),
      H(3, 'References'),
      P(T('[Citations, legislation, and supporting documents]')),
    ]},
  },
  {
    id: 'concept-note',
    name: 'Concept Note',
    description: 'Early-stage proposal outlining a project idea for approval',
    emoji: '💡',
    category: 'Policy & Strategy',
    sections: ['Background & Context', 'Problem Statement', 'Proposed Solution', 'Objectives', 'Target Groups', 'Key Activities', 'Expected Outcomes', 'Budget Estimate', 'Risks'],
    content: { type: 'doc', content: [
      H(2, 'Concept Note'),
      P(B('Project Title:\u00a0'), T('[Title of Proposed Project / Programme]')),
      P(B('Submitting Organisation:\u00a0'), T('[Organisation / Department Name]')),
      P(B('Contact Person:\u00a0'), T('[Name, Title, Email, Phone]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Estimated Budget:\u00a0'), T('[Currency and Amount]')),
      P(B('Proposed Duration:\u00a0'), T('[e.g., 18 months]')),
      HR(),
      H(3, '1. Background & Context'),
      P(T('[Describe the current situation, policy environment, and the gap or need this project addresses. Include relevant statistics or evidence]')),
      H(3, '2. Problem Statement'),
      P(T('[Clearly articulate the specific problem to be solved. Who is affected, how severely, and what happens if no action is taken?]')),
      H(3, '3. Proposed Solution & Rationale'),
      P(T('[Describe the proposed intervention and why this approach is the most appropriate response to the identified problem]')),
      H(3, '4. Objectives'),
      P(B('Overall Objective:\u00a0'), T('[The broader development goal this project contributes to]')),
      P(B('Specific Objectives:\u00a0')),
      OL('[Specific objective 1]', '[Specific objective 2]', '[Specific objective 3]'),
      H(3, '5. Target Groups'),
      BL('[Primary beneficiaries — who directly benefits]', '[Secondary beneficiaries — who indirectly benefits]'),
      H(3, '6. Key Activities'),
      OL('[Activity 1]', '[Activity 2]', '[Activity 3]'),
      H(3, '7. Expected Outcomes & Impact'),
      TABLE(
        TH('Outcome', 'Indicator', 'Target'),
        TR('[Outcome 1]', '[Measurable indicator]', '[Target value by end]'),
        TR('[Outcome 2]', '[Measurable indicator]', '[Target value by end]'),
      ),
      H(3, '8. Implementation Approach'),
      P(T('[Describe how the project will be implemented — partnerships, phases, geographic coverage, institutional arrangements]')),
      H(3, '9. Budget Estimate'),
      TABLE(
        TH('Cost Category', 'Estimated Amount', 'Notes'),
        TR('[Personnel]', '[Amount]', ''),
        TR('[Operations & Travel]', '[Amount]', ''),
        TR('[Equipment / Materials]', '[Amount]', ''),
        TR('[Training & Workshops]', '[Amount]', ''),
        TR('Total', '[Amount]', ''),
      ),
      H(3, '10. Organisational Capacity'),
      P(T('[Brief statement of the organisation\'s relevant experience and capacity to implement this project]')),
      H(3, '11. Risks & Mitigation'),
      TABLE(
        TH('Risk', 'Likelihood', 'Mitigation'),
        TR('[Risk description]', '[High / Medium / Low]', '[Mitigation measure]'),
      ),
    ]},
  },
  {
    id: 'tor-committee',
    name: 'Terms of Reference — Committee',
    description: 'Mandate, membership, quorum, and functions of a committee or working group',
    emoji: '📜',
    category: 'Policy & Strategy',
    sections: ['Background', 'Mandate & Purpose', 'Functions', 'Membership', 'Quorum', 'Decision Making', 'Meetings', 'Reporting', 'Duration'],
    content: { type: 'doc', content: [
      H(2, 'Terms of Reference'),
      P(B('Name:\u00a0'), T('[Full Name of Committee / Working Group / Task Force]')),
      P(B('Established by:\u00a0'), T('[Authority that established this body]')),
      P(B('Date Established:\u00a0'), T('[Date]')),
      P(B('Review Date:\u00a0'), T('[Date]')),
      HR(),
      H(3, '1. Background'),
      P(T('[Context that necessitates this committee — policy, legislative, or operational driver]')),
      H(3, '2. Mandate & Purpose'),
      P(T('[The overall mandate and the specific purpose for which this body has been established]')),
      H(3, '3. Functions'),
      BL(
        '[Function 1 — e.g., Review and recommend policy changes]',
        '[Function 2 — e.g., Monitor implementation of decisions]',
        '[Function 3 — e.g., Coordinate cross-departmental responses]',
        '[Function 4 — e.g., Report to the relevant authority on progress]',
      ),
      H(3, '4. Membership'),
      TABLE(
        TH('Position', 'Name / Title', 'Department / Organisation', 'Role'),
        TR('Chairperson', '[Name, Title]', '[Department]', 'Chair'),
        TR('Deputy Chairperson', '[Name, Title]', '[Department]', 'Deputy Chair'),
        TR('Member', '[Name, Title]', '[Department]', 'Member'),
        TR('Secretary', '[Name, Title]', '[Department]', 'Secretary'),
      ),
      H(3, '5. Quorum'),
      P(T('[State the minimum number of members required for valid deliberations, e.g., "A quorum shall consist of more than half of the members"]')),
      H(3, '6. Decision Making'),
      P(T('[Describe how decisions are made — consensus, majority vote, or chairperson\'s casting vote]')),
      H(3, '7. Meetings'),
      P(T('[Frequency of meetings, e.g., monthly. Special meetings may be convened by the Chairperson as required. Agenda to be circulated at least 5 working days in advance]')),
      H(3, '8. Reporting'),
      P(T('[To whom the committee reports, reporting frequency, and the format of reports]')),
      H(3, '9. Secretariat'),
      P(T('[Department or unit responsible for providing secretariat services]')),
      H(3, '10. Duration'),
      P(T('[Whether this is a standing committee or a time-bound task force, and the review/expiry date of these ToR]')),
      HR(),
      P(T('Approved by: ____________________________  Date: ____________')),
    ]},
  },
  {
    id: 'stakeholder-plan',
    name: 'Stakeholder Engagement Plan',
    description: 'Stakeholder mapping, engagement strategies, and communication schedule',
    emoji: '🤝',
    category: 'Policy & Strategy',
    sections: ['Purpose', 'Stakeholder Analysis', 'Engagement Objectives', 'Engagement Methods', 'Communication Plan', 'Feedback Mechanism', 'Monitoring & Reporting'],
    content: { type: 'doc', content: [
      H(2, 'Stakeholder Engagement Plan'),
      P(B('Project / Initiative:\u00a0'), T('[Name]')),
      P(B('Prepared by:\u00a0'), T('[Name, Department]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Version:\u00a0'), T('1.0')),
      HR(),
      H(3, '1. Purpose'),
      P(T('[Why stakeholder engagement is necessary for this project and what this plan aims to achieve]')),
      H(3, '2. Stakeholder Identification & Analysis'),
      TABLE(
        TH('Stakeholder', 'Interest', 'Level of Influence', 'Level of Impact', 'Engagement Level'),
        TR('[Name / Group]', '[Their interest in the project]', '[High / Medium / Low]', '[High / Medium / Low]', '[Inform / Consult / Involve / Partner]'),
        TR('[Name / Group]', '[Their interest in the project]', '[High / Medium / Low]', '[High / Medium / Low]', '[Inform / Consult / Involve / Partner]'),
      ),
      H(3, '3. Engagement Objectives'),
      BL('[Objective 1 — e.g., Build awareness and understanding]', '[Objective 2 — e.g., Gather feedback on proposed options]', '[Objective 3 — e.g., Build coalition of support]'),
      H(3, '4. Engagement Methods'),
      TABLE(
        TH('Stakeholder Group', 'Method', 'Responsible', 'Frequency'),
        TR('[Group]', '[Workshop / Briefing / Survey / Consultation]', '[Name]', '[Monthly / Ad hoc]'),
        TR('[Group]', '[Newsletter / Portal / Email Update]', '[Name]', '[Quarterly]'),
      ),
      H(3, '5. Communication Plan'),
      TABLE(
        TH('Message / Content', 'Audience', 'Channel', 'Timing', 'Owner'),
        TR('[Key message]', '[Audience]', '[Email / Meeting / Portal]', '[Date]', '[Name]'),
      ),
      H(3, '6. Feedback & Grievance Mechanism'),
      P(T('[How stakeholders can raise concerns, provide feedback, or lodge complaints. Include contact details and response timelines]')),
      H(3, '7. Monitoring & Reporting'),
      P(T('[How engagement activities will be tracked and reported. Include KPIs such as attendance rates, feedback response rates, or number of engagements conducted]')),
    ]},
  },

  // ── Reports ─────────────────────────────────────────────────────────────────
  {
    id: 'incident',
    name: 'Incident Report',
    description: 'Incident details, impact, response, lessons learned',
    emoji: '🚨',
    category: 'Reports',
    sections: ['Incident Description', 'Impact Assessment', 'Root Cause Analysis', 'Response Actions', 'Lessons Learned', 'Corrective Actions'],
    content: { type: 'doc', content: [
      H(2, 'Incident Report'),
      P(B('Report Number:\u00a0'), T('[INC-YYYY-000]')),
      P(B('Date of Incident:\u00a0'), T('[Date and Time]')),
      P(B('Date of Report:\u00a0'), T('[Date]')),
      P(B('Reported By:\u00a0'), T('[Name, Title, Department]')),
      P(B('Severity:\u00a0'), T('[Critical / High / Medium / Low]')),
      HR(),
      H(3, '1. Incident Description'),
      P(T('[Provide a clear, factual description of what occurred, where, and how]')),
      H(3, '2. Impact Assessment'),
      BL('[Systems affected: ...]', '[Users affected: ...]', '[Duration: ...]', '[Data breach: Yes / No]'),
      H(3, '3. Root Cause Analysis'),
      P(T('[Describe the root cause of the incident]')),
      H(3, '4. Response Actions Taken'),
      OL('[Action taken and by whom]', '[Containment measures]', '[Recovery steps]'),
      H(3, '5. Lessons Learned'),
      P(T('[Key lessons and how they will improve future response]')),
      H(3, '6. Corrective Actions'),
      TABLE(
        TH('Action', 'Owner', 'Target Date', 'Status'),
        TR('[Corrective action]', '[Name]', '[Date]', 'Open'),
      ),
    ]},
  },
  {
    id: 'project-charter',
    name: 'Project Charter',
    description: 'Objectives, stakeholders, deliverables, milestones',
    emoji: '🗂️',
    category: 'Reports',
    sections: ['Overview', 'Objectives', 'Scope', 'Stakeholders', 'Key Deliverables', 'Milestones', 'Risks & Assumptions', 'Budget', 'Approval'],
    content: { type: 'doc', content: [
      H(2, 'Project Charter'),
      P(B('Project Name:\u00a0'), T('[Project Name]')),
      P(B('Project Manager:\u00a0'), T('[Name, Title]')),
      P(B('Sponsor:\u00a0'), T('[Executive Sponsor Name, Title]')),
      P(B('Start Date:\u00a0'), T('[Date]')),
      P(B('Target Completion:\u00a0'), T('[Date]')),
      HR(),
      H(3, '1. Project Overview'),
      P(T('[Brief description of the project and its strategic alignment]')),
      H(3, '2. Objectives'),
      BL('[Specific, measurable objective 1]', '[Specific, measurable objective 2]'),
      H(3, '3. Scope'),
      H(4, 'In Scope'),
      BL('[In-scope item]'),
      H(4, 'Out of Scope'),
      BL('[Out-of-scope item]'),
      H(3, '4. Stakeholders'),
      TABLE(
        TH('Name', 'Role', 'Department', 'Responsibility'),
        TR('[Name]', '[Role]', '[Department]', '[Responsibility]'),
      ),
      H(3, '5. Key Deliverables'),
      BL('[Deliverable 1]', '[Deliverable 2]'),
      H(3, '6. Milestones'),
      TABLE(
        TH('Milestone', 'Target Date', 'Status'),
        TR('[Milestone name]', '[Date]', 'Planned'),
      ),
      H(3, '7. Risks & Assumptions'),
      P(T('[Key risks, assumptions, constraints, and dependencies]')),
      H(3, '8. Budget'),
      P(T('[Approved budget and funding source]')),
      H(3, '9. Approval'),
      P(T('Approved by: ____________________________  Date: ____________')),
    ]},
  },
  {
    id: 'progress-report',
    name: 'Progress Report',
    description: 'Project/programme progress against objectives, financials, and next steps',
    emoji: '📈',
    category: 'Reports',
    sections: ['Executive Summary', 'Progress vs Objectives', 'Completed Activities', 'In Progress', 'Financial Summary', 'Issues & Risks', 'Next Period Plan', 'Recommendations'],
    content: { type: 'doc', content: [
      H(2, 'Progress Report'),
      P(B('Project / Programme:\u00a0'), T('[Name]')),
      P(B('Reporting Period:\u00a0'), T('[e.g., Q1 2026 / January – March 2026]')),
      P(B('Prepared by:\u00a0'), T('[Name, Department]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Overall Status:\u00a0'), T('[On Track / At Risk / Delayed]')),
      HR(),
      H(3, '1. Executive Summary'),
      P(T('[2–3 sentence summary of overall progress, key achievements, and any issues this period]')),
      H(3, '2. Progress Against Objectives'),
      TABLE(
        TH('Objective', 'Target', 'Achievement', 'Status', 'Notes'),
        TR('[Objective 1]', '[Target]', '[What was achieved]', '[On Track / At Risk]', ''),
        TR('[Objective 2]', '[Target]', '[What was achieved]', '[On Track / At Risk]', ''),
      ),
      H(3, '3. Key Activities Completed'),
      BL('[Activity 1 — brief description and outcome]', '[Activity 2 — brief description and outcome]'),
      H(3, '4. Activities In Progress'),
      TABLE(
        TH('Activity', 'Lead', '% Complete', 'Expected Completion'),
        TR('[Activity name]', '[Name]', '[%]', '[Date]'),
      ),
      H(3, '5. Financial Summary'),
      TABLE(
        TH('Budget Line', 'Approved Budget', 'Expenditure to Date', 'Balance', 'Notes'),
        TR('[Personnel]', '[Amount]', '[Amount]', '[Amount]', ''),
        TR('[Operations]', '[Amount]', '[Amount]', '[Amount]', ''),
        TR('Total', '[Amount]', '[Amount]', '[Amount]', ''),
      ),
      H(3, '6. Issues, Risks & Escalations'),
      TABLE(
        TH('Issue / Risk', 'Impact', 'Action Taken / Required', 'Owner', 'Due Date'),
        TR('[Description]', '[High / Medium / Low]', '[Action]', '[Name]', '[Date]'),
      ),
      H(3, '7. Planned Activities Next Period'),
      OL('[Activity 1]', '[Activity 2]', '[Activity 3]'),
      H(3, '8. Recommendations'),
      P(T('[Any recommendations for management decision or support needed]')),
    ]},
  },
  {
    id: 'risk-register',
    name: 'Risk Register',
    description: 'Comprehensive risk log with likelihood, impact, and mitigation',
    emoji: '⚠️',
    category: 'Reports',
    sections: ['Rating Matrix', 'Risk Log', 'Risk Summary'],
    content: { type: 'doc', content: [
      H(2, 'Risk Register'),
      P(B('Project / Department:\u00a0'), T('[Name]')),
      P(B('Risk Owner:\u00a0'), T('[Name, Title]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Version:\u00a0'), T('1.0')),
      HR(),
      H(3, 'Risk Rating Matrix'),
      P(T('Likelihood: 1 = Rare  2 = Unlikely  3 = Possible  4 = Likely  5 = Almost Certain')),
      P(T('Impact:      1 = Negligible  2 = Minor  3 = Moderate  4 = Major  5 = Catastrophic')),
      P(T('Risk Rating = Likelihood × Impact   (1–5 Low | 6–12 Medium | 13–19 High | 20–25 Critical)')),
      HR(),
      H(3, 'Risk Log'),
      TABLE(
        TH('ID', 'Risk Description', 'Category', 'Likelihood', 'Impact', 'Rating', 'Mitigation / Control', 'Contingency', 'Owner', 'Review Date', 'Status'),
        TR('R-001', '[Description of risk]', '[Strategic / Operational / Financial / Compliance]', '3', '4', '12 – Medium', '[Preventive actions]', '[If risk occurs]', '[Name]', '[Date]', 'Open'),
        TR('R-002', '[Description of risk]', '[Strategic / Operational / Financial / Compliance]', '2', '5', '10 – Medium', '[Preventive actions]', '[If risk occurs]', '[Name]', '[Date]', 'Open'),
      ),
      H(3, 'Summary'),
      TABLE(
        TH('Rating', 'Count', 'Key Risks'),
        TR('Critical (20–25)', '0', ''),
        TR('High (13–19)', '0', ''),
        TR('Medium (6–12)', '2', 'R-001, R-002'),
        TR('Low (1–5)', '0', ''),
      ),
    ]},
  },
  {
    id: 'weekly-report',
    name: 'Weekly Status Report',
    description: 'Progress, blockers, upcoming tasks for weekly reporting',
    emoji: '📊',
    category: 'Reports',
    sections: ['Summary', 'Completed This Week', 'In Progress', 'Planned for Next Week', 'Issues & Blockers', 'Key Metrics'],
    content: { type: 'doc', content: [
      H(2, 'Weekly Status Report'),
      P(B('Week Ending:\u00a0'), T('[Date]')),
      P(B('Prepared by:\u00a0'), T('[Name, Department]')),
      HR(),
      H(3, 'Summary'),
      P(T('[Brief overall summary of the week]')),
      H(3, 'Completed This Week'),
      BL('[Completed task or milestone]'),
      H(3, 'In Progress'),
      BL('[Ongoing task — % complete, expected completion]'),
      H(3, 'Planned for Next Week'),
      BL('[Planned task]'),
      H(3, 'Issues & Blockers'),
      BL('[Issue description and impact — action/support needed]'),
      H(3, 'Key Metrics'),
      P(T('[Relevant KPIs or performance metrics for the week]')),
    ]},
  },

  // ── Planning & Procurement ──────────────────────────────────────────────────
  {
    id: 'tor-consultancy',
    name: 'Terms of Reference — Consultancy',
    description: 'Scope of work, deliverables, and qualifications for a consultant',
    emoji: '📑',
    category: 'Planning & Procurement',
    sections: ['Background', 'Objective', 'Scope of Work', 'Deliverables', 'Required Qualifications', 'Reporting', 'Payment Terms', 'Application Process'],
    content: { type: 'doc', content: [
      H(2, 'Terms of Reference'),
      P(B('Assignment Title:\u00a0'), T('[Title of Consultancy Assignment]')),
      P(B('Contracting Organisation:\u00a0'), T('[Organisation Name]')),
      P(B('Department:\u00a0'), T('[Department / Division]')),
      P(B('Duration:\u00a0'), T('[e.g., 30 working days over 3 months]')),
      P(B('Estimated Start Date:\u00a0'), T('[Date]')),
      P(B('Budget:\u00a0'), T('[Amount / "Subject to negotiation"]')),
      HR(),
      H(3, '1. Background'),
      P(T('[Context that necessitates this consultancy. Describe the organisation, the project or programme, and the specific gap or need that requires external expertise]')),
      H(3, '2. Objective of the Assignment'),
      P(T('[Clear statement of what the consultancy is expected to achieve]')),
      H(3, '3. Scope of Work'),
      OL(
        '[Task 1 — detailed description]',
        '[Task 2 — detailed description]',
        '[Task 3 — detailed description]',
        '[Task 4 — detailed description]',
      ),
      H(3, '4. Deliverables'),
      TABLE(
        TH('Deliverable', 'Description', 'Due Date'),
        TR('[Inception Report]', '[Brief outlining methodology and work plan]', '[Date]'),
        TR('[Draft Report]', '[First draft for review and feedback]', '[Date]'),
        TR('[Final Report]', '[Incorporating all feedback]', '[Date]'),
      ),
      H(3, '5. Required Qualifications & Experience'),
      H(4, 'Essential'),
      BL(
        '[Minimum education qualification, e.g., Masters degree in relevant field]',
        '[Minimum years of experience]',
        '[Specific technical expertise required]',
        '[Proven track record with similar assignments]',
      ),
      H(4, 'Desirable'),
      BL('[Additional preferred qualification or experience]', '[Language requirements if any]'),
      H(3, '6. Reporting & Supervision'),
      P(T('[To whom the consultant reports, frequency of progress updates, and how quality will be assured]')),
      H(3, '7. Payment Terms'),
      P(T('[Milestone-based payments linked to deliverables. Specify percentage per deliverable]')),
      H(3, '8. Application Process'),
      P(T('[How to apply, documents required (CV, technical and financial proposals), and submission deadline]')),
      P(B('Submission Deadline:\u00a0'), T('[Date]')),
      P(B('Submit to:\u00a0'), T('[Email / Postal address]')),
    ]},
  },
  {
    id: 'budget-proposal',
    name: 'Budget Proposal',
    description: 'Departmental or project budget request with justification',
    emoji: '💰',
    category: 'Planning & Procurement',
    sections: ['Executive Summary', 'Strategic Alignment', 'Budget Summary', 'Detailed Justification', 'Revenue & Funding Sources', 'Cost-Benefit Analysis', 'Risks of Non-Funding', 'Approval'],
    content: { type: 'doc', content: [
      H(2, 'Budget Proposal'),
      P(B('Department / Project:\u00a0'), T('[Name]')),
      P(B('Fiscal Year:\u00a0'), T('[e.g., FY 2026/27]')),
      P(B('Prepared by:\u00a0'), T('[Name, Title]')),
      P(B('Date:\u00a0'), T('[Date]')),
      P(B('Total Amount Requested:\u00a0'), T('[Currency and Amount]')),
      HR(),
      H(3, '1. Executive Summary'),
      P(T('[Brief summary of the budget request, its purpose, and strategic justification — max 150 words]')),
      H(3, '2. Strategic Alignment'),
      P(T('[How this budget request aligns to the organisation\'s strategic plan, government priorities, or mandate]')),
      H(3, '3. Budget Summary'),
      TABLE(
        TH('Category', 'FY Current Year (Actual)', 'FY Current Year (Budget)', 'FY Next Year (Requested)', 'Change (%)', 'Justification'),
        TR('[Personnel]', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
        TR('[Operations & Admin]', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
        TR('[Capital Expenditure]', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
        TR('[Programmes & Projects]', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
        TR('[Training & Capacity]', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
        TR('TOTAL', '[Amount]', '[Amount]', '[Amount]', '[%]', ''),
      ),
      H(3, '4. Detailed Justification'),
      H(4, 'Personnel Costs'),
      P(T('[Number of posts, salary scales, and justification for any new positions]')),
      H(4, 'Operational Costs'),
      P(T('[Breakdown and rationale for operational expenditure]')),
      H(4, 'Capital Expenditure'),
      P(T('[Assets to be acquired, procurement plan, and expected lifespan]')),
      H(4, 'Programme / Project Funding'),
      P(T('[List of funded activities, expected outputs, and link to strategic objectives]')),
      H(3, '5. Revenue & Funding Sources'),
      TABLE(
        TH('Source', 'Amount', 'Conditions / Notes'),
        TR('[Government Appropriation]', '[Amount]', ''),
        TR('[Donor Funding]', '[Amount]', '[Donor name, project]'),
        TR('[Own Revenue / Fees]', '[Amount]', ''),
        TR('Total', '[Amount]', ''),
      ),
      H(3, '6. Cost-Benefit Analysis'),
      P(T('[Expected returns, savings, or outcomes relative to the cost of this investment]')),
      H(3, '7. Risks of Non-Funding'),
      P(T('[Impact if the budget request is not approved — service delivery gaps, compliance risks, etc.]')),
      H(3, '8. Approval'),
      P(T('Prepared by: ____________________________  Date: ____________')),
      P(T('Reviewed by: ____________________________  Date: ____________')),
      P(T('Approved by: ____________________________  Date: ____________')),
    ]},
  },
  {
    id: 'training-plan',
    name: 'Training & Capacity Building Plan',
    description: 'Learning objectives, modules, schedule, and evaluation framework',
    emoji: '🎓',
    category: 'Planning & Procurement',
    sections: ['Purpose & Background', 'Learning Objectives', 'Target Participants', 'Training Modules', 'Training Schedule', 'Resources Required', 'Evaluation & Monitoring', 'Certification'],
    content: { type: 'doc', content: [
      H(2, 'Training & Capacity Building Plan'),
      P(B('Programme Name:\u00a0'), T('[Name of Training Programme]')),
      P(B('Target Audience:\u00a0'), T('[Who will be trained — role, department, level]')),
      P(B('Planned Period:\u00a0'), T('[Start Date – End Date]')),
      P(B('Prepared by:\u00a0'), T('[Name, Department]')),
      P(B('Date:\u00a0'), T('[Date]')),
      HR(),
      H(3, '1. Purpose & Background'),
      P(T('[Why this training is needed — skills gaps identified, performance issues, new policy or system requirements, or strategic priorities]')),
      H(3, '2. Learning Objectives'),
      P(T('By the end of this programme, participants will be able to:')),
      OL('[Objective 1]', '[Objective 2]', '[Objective 3]'),
      H(3, '3. Target Participants'),
      TABLE(
        TH('Department / Unit', 'Number of Participants', 'Level', 'Notes'),
        TR('[Department]', '[Number]', '[Officer / Manager / Executive]', ''),
        TR('[Department]', '[Number]', '[Officer / Manager / Executive]', ''),
      ),
      H(3, '4. Training Modules'),
      TABLE(
        TH('Module', 'Topics Covered', 'Duration', 'Delivery Method', 'Facilitator'),
        TR('[Module 1: Title]', '[Key topics]', '[Hours / Days]', '[In-person / Online / Blended]', '[Name / External Provider]'),
        TR('[Module 2: Title]', '[Key topics]', '[Hours / Days]', '[In-person / Online / Blended]', '[Name / External Provider]'),
        TR('[Module 3: Title]', '[Key topics]', '[Hours / Days]', '[In-person / Online / Blended]', '[Name / External Provider]'),
      ),
      H(3, '5. Training Schedule'),
      TABLE(
        TH('Date', 'Module', 'Venue / Platform', 'Facilitator', 'Target Group'),
        TR('[Date]', '[Module 1]', '[Venue]', '[Name]', '[Department]'),
        TR('[Date]', '[Module 2]', '[Venue]', '[Name]', '[Department]'),
      ),
      H(3, '6. Resources Required'),
      TABLE(
        TH('Resource', 'Details', 'Estimated Cost'),
        TR('Venue / Platform', '[Name / Link]', '[Amount]'),
        TR('Training Materials', '[Manuals, handouts]', '[Amount]'),
        TR('External Facilitators', '[Name / Organisation]', '[Amount]'),
        TR('Catering', '[If applicable]', '[Amount]'),
        TR('Total', '', '[Amount]'),
      ),
      H(3, '7. Evaluation & Monitoring'),
      P(B('Pre-training assessment:\u00a0'), T('[Knowledge/skills baseline assessment method]')),
      P(B('Post-training assessment:\u00a0'), T('[Test, assignment, or practical demonstration]')),
      P(B('Participant feedback:\u00a0'), T('[Feedback form to be completed at end of each module]')),
      P(B('3-month follow-up:\u00a0'), T('[Supervisor evaluation of applied learning on the job]')),
      H(3, '8. Certification'),
      P(T('[Whether participants will receive a certificate, and from whom — internal or accredited body]')),
    ]},
  },
];

const CATEGORIES = [...new Set(TEMPLATES.map((t) => t.category))];

interface TemplatePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: { title: string; emoji: string; content: string }) => void;
}

export function TemplatePickerDialog({ open, onOpenChange, onSelect }: TemplatePickerDialogProps) {
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);

  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem('user_templates');
      setUserTemplates(raw ? (JSON.parse(raw) as UserTemplate[]) : []);
    } catch {
      setUserTemplates([]);
    }
  }, [open]);

  function deleteUserTemplate(id: string) {
    const next = userTemplates.filter((t) => t.id !== id);
    setUserTemplates(next);
    localStorage.setItem('user_templates', JSON.stringify(next));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] sm:max-w-[92vw] max-h-[88vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>New page</DialogTitle>
          <p className="text-sm text-muted-foreground mt-0.5">Choose a template to get started quickly</p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* My Templates section */}
          {userTemplates.length > 0 && (
            <div className="mb-7">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">My Templates</p>
              <div className="grid grid-cols-3 gap-3">
                {userTemplates.map((template) => (
                  <div key={template.id} className="relative group/card">
                    <button
                      type="button"
                      className={cn(
                        'w-full flex flex-col gap-2.5 p-3.5 rounded-lg border border-border text-left',
                        'hover:bg-muted/50 hover:border-primary/40 transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                      onClick={() => {
                        onSelect({
                          title: template.name,
                          emoji: template.emoji,
                          content: template.content ?? JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
                        });
                        onOpenChange(false);
                      }}
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="text-xl shrink-0 leading-tight">{template.emoji}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold leading-tight">{template.name}</p>
                          {template.description && (
                            <p className="text-[0.6875rem] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{template.description}</p>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      title="Delete template"
                      className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded text-muted-foreground/50 hover:text-destructive hover:bg-muted opacity-0 group-hover/card:opacity-100 transition-opacity text-xs leading-none"
                      onClick={() => deleteUserTemplate(template.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {CATEGORIES.map((category) => (
            <div key={category} className="mb-7">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2.5">{category}</p>
              <div className="grid grid-cols-3 gap-3">
                {TEMPLATES.filter((t) => t.category === category).map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={cn(
                      'flex flex-col gap-2.5 p-3.5 rounded-lg border border-border text-left',
                      'hover:bg-muted/50 hover:border-primary/40 transition-colors',
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
                    {/* Header row */}
                    <div className="flex items-start gap-2.5">
                      <span className="text-xl shrink-0 leading-tight">{template.emoji}</span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">{template.name}</p>
                        <p className="text-[0.6875rem] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{template.description}</p>
                      </div>
                    </div>

                    {/* Section skeleton */}
                    {template.sections.length > 0 && (
                      <div className="flex flex-col gap-1 pt-2 border-t border-border/60">
                        {template.sections.slice(0, 6).map((section) => (
                          <div key={section} className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
                            <span className="text-[0.625rem] text-muted-foreground/70 leading-tight truncate">{section}</span>
                          </div>
                        ))}
                        {template.sections.length > 6 && (
                          <span className="text-[0.625rem] text-muted-foreground/40 pl-2.5">
                            +{template.sections.length - 6} more sections
                          </span>
                        )}
                      </div>
                    )}
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
