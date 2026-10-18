// Rivetdeck uninstall data helper: NSIS System::Call entry points over the cleanup
// orchestration. Every deletion outside $INSTDIR flows through UninstallCleanup.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#define _UNICODE
#include <windows.h>
#include "uninstall-data.h"
#include "uninstall-cleanup.h"

// Parameters: userData root, installation dir, env DSH_HOME (may be empty), path-history
// file, updater cache dir, residue report path, deleteAppData flag, out removed count,
// out residue count. Returns the first Win32 error seen, or 0.
extern "C" __declspec(dllexport) DWORD __cdecl UninstallCleanup(
    LPCWSTR userData, LPCWSTR installation, LPCWSTR protectedHome,
    LPCWSTR historyFile, LPCWSTR updaterCache, LPCWSTR residueReport,
    int deleteAppData, int* removed, int* residue) {
    uninstall_cleanup::CleanupRequest request;
    request.userData = userData;
    request.installation = installation;
    request.protectedHome = protectedHome;
    request.historyFile = historyFile;
    request.updaterCache = updaterCache;
    request.residueReport = residueReport;
    request.deleteAppData = deleteAppData;
    request.removed = removed;
    request.residue = residue;
    return uninstall_cleanup::Cleanup(request);
}
