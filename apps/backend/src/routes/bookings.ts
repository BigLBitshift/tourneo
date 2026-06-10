import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { createBookingSchema } from '../validators/bookings';
import { CourtBookingService } from '../services/courtBookingService';

const router = Router();

// Book an available slot
router.post(
  '/',
  authenticate,
  validateBody(createBookingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await CourtBookingService.bookSlot(
        req.body.slot_id,
        req.user!.userId,
        req.body.notes
      );
      res.status(201).json({ success: true, data: booking });
    } catch (error) {
      next(error);
    }
  }
);

// My bookings (?upcoming=true filters to confirmed future bookings)
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookings = await CourtBookingService.listUserBookings(req.user!.userId, {
      upcomingOnly: req.query.upcoming === 'true',
    });
    res.json({ success: true, data: bookings });
  } catch (error) {
    next(error);
  }
});

// Cancel a booking (frees the slot; >= 2h before start)
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    const isAdmin = req.user!.role === 'admin' || req.user!.role === 'superadmin';
    const result = await CourtBookingService.cancelBooking(bookingId, req.user!.userId, isAdmin);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

export { router as bookingRouter };
