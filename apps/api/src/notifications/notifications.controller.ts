import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string };
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** GET /notifications */
  @Get()
  getNotifications(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.notificationsService.getNotifications(
      req.user.sub,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /** GET /notifications/unread-count */
  @Get('unread-count')
  getUnreadCount(@Req() req: AuthenticatedRequest) {
    return this.notificationsService.getUnreadCount(req.user.sub).then((count) => ({ count }));
  }

  /** PATCH /notifications/read-all */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@Req() req: AuthenticatedRequest) {
    return this.notificationsService.markAllRead(req.user.sub);
  }

  /** PATCH /notifications/:id/read */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.notificationsService.markRead(req.user.sub, id);
  }

  /** DELETE /notifications/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteNotification(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.notificationsService.deleteNotification(req.user.sub, id);
  }
}
