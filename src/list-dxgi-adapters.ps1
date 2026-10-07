$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TaskDxgiAdapters {
 [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapters(IntPtr self, uint index, out IntPtr adapter);
 [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc(IntPtr self, out Desc desc);
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Desc {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Name;
  public uint VendorId, DeviceId, SubSysId, Revision;
  public UIntPtr VideoMemory, SystemMemory, SharedMemory;
  public uint LuidLow; public int LuidHigh;
 }
 public class Adapter { public uint deviceId; public uint vendorId; public string name; }
 public static Adapter[] List() {
  Guid iid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IntPtr factory;
  Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid,out factory));
  var result=new List<Adapter>();
  try {
   IntPtr table=Marshal.ReadIntPtr(factory);
   var enumerate=(EnumAdapters)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table,7*IntPtr.Size),typeof(EnumAdapters));
   for(uint i=0;i<64;i++) {
    IntPtr adapter; int hr=enumerate(factory,i,out adapter);
    if(hr==unchecked((int)0x887A0002))break; Marshal.ThrowExceptionForHR(hr);
    try {var get=(GetDesc)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter),8*IntPtr.Size),typeof(GetDesc));Desc desc;Marshal.ThrowExceptionForHR(get(adapter,out desc));result.Add(new Adapter{deviceId=i,vendorId=desc.VendorId,name=desc.Name});}
    finally {Marshal.Release(adapter);}
   }
  } finally {Marshal.Release(factory);}
  return result.ToArray();
 }
}
"@
ConvertTo-Json -InputObject @([TaskDxgiAdapters]::List()) -Compress
