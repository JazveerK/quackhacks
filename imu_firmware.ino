/*
 * imu_firmware.ino — SteadyPT thigh IMU (MPU6050 -> CSV serial).
 *
 * Streams one CSV line per sample over USB serial for imu.py to read:
 *
 *     ax,ay,az,gx,gy,gz,t
 *
 *     ax,ay,az : accelerometer, in g
 *     gx,gy,gz : gyroscope, in deg/s
 *     t        : millis() timestamp
 *
 * ~100 Hz, 115200 baud. Matches CONTEXT.md §4a exactly.
 *
 * Hardware (Arduino Uno):
 *     MPU6050 VCC -> 5V
 *     MPU6050 GND -> GND
 *     MPU6050 SDA -> A4
 *     MPU6050 SCL -> A5
 *
 * Library: "Adafruit MPU6050" (install via the Arduino Library Manager; it pulls
 * in Adafruit Unified Sensor + Adafruit BusIO).
 */

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

// Convert the Adafruit readings (SI units) to the CSV contract's units.
static const float MS2_TO_G = 1.0f / 9.80665f;     // m/s^2 -> g
static const float RAD_TO_DEG = 57.2957795f;        // rad/s -> deg/s

// ~100 Hz cadence (10 ms/sample). imu.py derives real dt from the millis stamp,
// so a little jitter here is fine.
static const unsigned long SAMPLE_INTERVAL_MS = 10;
unsigned long lastSample = 0;

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    ; // wait for the serial port on boards that need it
  }

  if (!mpu.begin()) {
    // Halt visibly if the sensor isn't found — check the A4/A5 wiring.
    Serial.println(F("MPU6050 not found - check wiring (SDA->A4, SCL->A5)"));
    while (1) {
      delay(500);
    }
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

  delay(100);
}

void loop() {
  unsigned long now = millis();
  if (now - lastSample < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSample = now;

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  // ax,ay,az (g), gx,gy,gz (deg/s), t (millis)
  Serial.print(a.acceleration.x * MS2_TO_G, 4); Serial.print(',');
  Serial.print(a.acceleration.y * MS2_TO_G, 4); Serial.print(',');
  Serial.print(a.acceleration.z * MS2_TO_G, 4); Serial.print(',');
  Serial.print(g.gyro.x * RAD_TO_DEG, 3); Serial.print(',');
  Serial.print(g.gyro.y * RAD_TO_DEG, 3); Serial.print(',');
  Serial.print(g.gyro.z * RAD_TO_DEG, 3); Serial.print(',');
  Serial.println(now);
}
