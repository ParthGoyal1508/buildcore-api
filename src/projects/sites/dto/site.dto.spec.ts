import { ValidationPipe } from '@nestjs/common';

import { UpdateSiteDto } from './site.dto';

/** 036 I24: a geofence of 5,000 km flags nobody, which is a geofence off that looks on. */
describe('site geofence radius', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const update = { metatype: UpdateSiteDto, type: 'body' as const };

  it('accepts 5,000 m', async () => {
    await expect(
      pipe.transform({ geofenceRadiusMeters: 5000 }, update),
    ).resolves.toMatchObject({ geofenceRadiusMeters: 5000 });
  });

  it('refuses 5,001 m, naming the limit', async () => {
    const refused = await pipe
      .transform({ geofenceRadiusMeters: 5001 }, update)
      .catch((error) => error.getResponse().message.join(' '));
    expect(refused).toMatch(/at most 5000/);
  });
});
