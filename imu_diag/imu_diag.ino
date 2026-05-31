/*
 * imu_diag.ino — I2C wiring diagnostic for the SteadyPT thigh IMU (MPU6050).
 *
 * Flash this INSTEAD of imu_firmware.ino when the bus reads "nothing". It does
 * three checks and prints a verdict over serial at 115200 baud:
 *
 *   1. SDA/SCL line levels (BEFORE Wire starts) — are the lines floating high
 *      like a healthy idle I2C bus, or stuck low (short / miswire / dead pin)?
 *   2. A full I2C address scan (0x01..0x7E) — lists every device that ACKs.
 *   3. An explicit probe of the MPU6050's two possible addresses, 0x68 / 0x69.
 *
 * Read the verdict like this:
 *   - "SDA=LOW" or "SCL=LOW" while idle  -> that line is shorted to GND, miswired,
 *     or the pin/wire is bad. A healthy idle I2C line reads HIGH (pulled up).
 *   - both HIGH but scan finds nothing    -> lines are fine but the sensor isn't
 *     answering: unsoldered header pins, a dead jumper, or a bad chip.
 *   - device found at 0x68 (or 0x69)      -> wiring is GOOD; reflash imu_firmware.ino.
 *
 * Uno wiring (unchanged): VCC->3.3V, GND->GND, SDA->SDA(A4), SCL->SCL(A5).
 */

#include <Wire.h>

// Uno hardware I2C pins (SDA/SCL header by AREF are wired to these).
static const uint8_t PIN_SDA = A4;
static const uint8_t PIN_SCL = A5;

void scanLineLevels() {
  // Read the raw line state with the internal pull-ups ENABLED, before Wire
  // takes the pins over. On a healthy bus the module's pull-ups (plus these)
  // hold both lines HIGH at idle. A stuck-LOW line means a short or bad wire.
  pinMode(PIN_SDA, INPUT_PULLUP);
  pinMode(PIN_SCL, INPUT_PULLUP);
  delay(5);
  int sda = digitalRead(PIN_SDA);
  int scl = digitalRead(PIN_SCL);
  Serial.print(F("SDA="));
  Serial.print(sda ? F("HIGH") : F("LOW (stuck! short/miswire/bad wire)"));
  Serial.print(F("  SCL="));
  Serial.println(scl ? F("HIGH") : F("LOW (stuck! short/miswire/bad wire)"));
  if (sda && scl) {
    Serial.println(F("  -> both lines idle HIGH = bus looks electrically OK."));
  } else {
    Serial.println(F("  -> a LOW line is your fault. Fix that before anything else."));
  }
}

bool probe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;  // 0 == device ACKed
}

void scanBus() {
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    if (probe(addr)) {
      Serial.print(F("  device ACK at 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println(F("  no devices ACKed (sensor not answering)."));
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }
  delay(200);

  Serial.println(F("=== IMU I2C diagnostic ==="));

  Serial.println(F("[1] line levels (idle):"));
  scanLineLevels();

  Wire.begin();

  Serial.println(F("[2] full bus scan:"));
  scanBus();

  Serial.println(F("[3] MPU6050 address probe:"));
  Serial.print(F("  0x68: "));
  Serial.println(probe(0x68) ? F("FOUND - wiring good, flash imu_firmware.ino")
                             : F("no response"));
  Serial.print(F("  0x69: "));
  Serial.println(probe(0x69) ? F("FOUND (AD0 high) - wiring good, flash imu_firmware.ino")
                             : F("no response"));

  Serial.println(F("=== done (resets every 3s) ==="));
}

void loop() {
  delay(3000);
  setup();  // re-run so you can wiggle wires and watch the verdict change live
}
