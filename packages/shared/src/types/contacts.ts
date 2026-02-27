export interface ContactEmail {
  email: string;
  type: 'work' | 'personal' | 'other';
  primary?: boolean;
}

export interface ContactPhone {
  number: string;
  type: 'work' | 'mobile' | 'home' | 'other';
}

export interface Contact {
  id: string;
  zimbraId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  nickname: string | null;
  company: string | null;
  jobTitle: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  notes: string | null;
  photoUrl: string | null;
  tags: string[];
}
