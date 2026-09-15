import serial
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

s = serial.Serial('COM3', 115200, timeout=1)
s.setDTR(False)
s.setRTS(False)
time.sleep(3)

s.reset_input_buffer()
s.write(b"DUMP\n")
time.sleep(1)

start = time.time()
while time.time() - start < 4:
    if s.in_waiting:
        chunk = s.read(s.in_waiting).decode('utf-8', errors='ignore')
        print(chunk, end='')
    time.sleep(0.05)

s.close()
