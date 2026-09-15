import serial
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

try:
    s = serial.Serial('COM3', 115200, timeout=0.5)
    # Trigger ESP32 reboot via RTS/DTR
    s.setDTR(False)
    s.setRTS(True)
    time.sleep(0.1)
    s.setRTS(False)
    time.sleep(0.5)

    print("=== MONITORING ESP32 SERIAL OUTPUT ===")
    start = time.time()
    while time.time() - start < 15:
        if s.in_waiting:
            line = s.readline().decode('utf-8', errors='ignore')
            print(line, end='')
        time.sleep(0.01)
    
    print("\n=== SENDING STATUS & DUMP COMMANDS ===")
    s.write(b"STATUS\n")
    time.sleep(1)
    s.write(b"DUMP\n")
    time.sleep(2)
    while s.in_waiting:
        line = s.readline().decode('utf-8', errors='ignore')
        print(line, end='')

    s.close()
except Exception as e:
    print(f"Error: {e}")
