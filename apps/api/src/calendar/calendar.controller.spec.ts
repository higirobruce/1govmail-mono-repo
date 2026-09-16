import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

describe('CalendarController.createMinutes', () => {
  it('passes the caller, the event and the body straight through', async () => {
    const calendarService = {
      createMinutes: jest.fn().mockResolvedValue({ documentId: 'doc-1', linked: true }),
    } as unknown as CalendarService;
    const controller = new CalendarController(calendarService);

    const body = { title: 'Minutes', content: '{}' };
    const result = await controller.createMinutes({ user: { sub: 'u1' } } as any, 'e1', body as any);

    expect(calendarService.createMinutes).toHaveBeenCalledWith('u1', 'e1', body);
    expect(result).toEqual({ documentId: 'doc-1', linked: true });
  });
});
